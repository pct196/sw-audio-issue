/*
 * The smallest app that shows the problem.
 *
 * Join a room, then press "Add extra audio track". The page builds a 440 Hz tone
 * with Web Audio and hands it to the SDK as `inputAudioStream` on an additional
 * leg. Within about half a second of that leg connecting, the server pushes
 * `verto.mediaParams` and the SDK stops the tone track and calls getUserMedia to
 * replace it. The tone is gone, and on an auxiliary leg the replacement capture
 * is rejected as well, so the leg goes silent altogether.
 *
 * Screen share shows the same thing with a getDisplayMedia audio track.
 *
 * With ?maintone=1 the page publishes a 660 Hz tone on its own leg in place of the
 * microphone, and the probe in instrument.js reports which tones come back in the mix this
 * member receives. The server keeps this member's own 660 Hz out of that mix and lets its
 * additional device's 440 Hz through, which is reproduction 7.
 */
import {
  SignalWire,
  StaticCredentialProvider,
  setLogLevel,
  version
} from 'https://cdn.jsdelivr.net/npm/@signalwire/js@4.0.0-rc.3/dist/browser.mjs';

const {
  log,
  markSupplied,
  dropSocket,
  dropSocketOnNextPing,
  dropSocketBeforeNextPing,
  swallowNextPong,
  watchTones,
  stopWatchingTones
} = window.repro;

const el = (id) => document.getElementById(id);
const ui = {
  token: el('token'),
  destination: el('destination'),
  join: el('join'),
  leave: el('leave'),
  mic: el('mic'),
  video: el('video'),
  screen: el('screen'),
  extraAudio: el('extra-audio'),
  removeExtra: el('remove-extra'),
  dropSocket: el('drop-socket'),
  dropOnPing: el('drop-on-ping'),
  dropBeforePing: el('drop-before-ping'),
  swallowPong: el('swallow-pong'),
  resendPong: el('resend-pong'),
  local: el('local'),
  remote: el('remote')
};

let client = null;
let call = null;
let sharing = false;
let shareStatusSub = null;
let extraAttempts = 0;
let extraAnswered = 0;
let childLegs = [];

// Test-mode flags, off by default so the page behaves the same as every log captured
// so far. Each one exists to expose a defect the normal path hides.
const flags = new URLSearchParams(location.search);

// ?nowarm=1 skips the pre-dial device warm-up. The warm-up exists because the SDK
// races call setup against a hardcoded 6s budget and runs its own getUserMedia inside
// it, so a slow device fails the join. Skipping it puts the capture back inside the
// budget, which is the only way to capture that defect.
const skipWarm = flags.has('nowarm');

// ?supportedapi=1 shares through self.startScreenShare(), the only public way to start
// a share. It takes no options, so the SDK asks getDisplayMedia for video alone and
// Chrome hides the "Also share tab audio" checkbox: the user cannot opt in even
// manually. That gap is invisible on the normal path, which reaches the private
// vertoManager to ask for audio.
const useSupportedShareApi = flags.has('supportedapi');

// ?maintone=1 dials with a tone in place of the microphone and a card in place of the
// camera, so this page publishes a known tone on its OWN leg. Because the SDK builds the
// local stream from supplied streams alone, no microphone and no camera are opened at all:
// every tone in the room is then one this page put there deliberately, and there is no
// microphone anywhere to carry a tone acoustically from one leg to another. That is what
// makes reproduction 7's two outcomes comparable.
const publishOwnTone = flags.has('maintone');

// The two tones, and the bands the probe watches for them. One per publisher, so a tone in
// the received mix says which leg put it there.
const OWN_LEG_TONE_HZ = 660;
const CHILD_LEG_TONE_HZ = 440;
const WATCHED_TONES = [
  { hz: CHILD_LEG_TONE_HZ, name: `${CHILD_LEG_TONE_HZ} Hz (this page's additional device)` },
  { hz: OWN_LEG_TONE_HZ, name: `${OWN_LEG_TONE_HZ} Hz (this page's own leg)` }
];

el('sdk-version').textContent = version;
setLogLevel('debug');

// ---- remember the token and room between reloads ---------------------------
// Stored on `input`, so a pasted value is kept the moment it lands. `change` only
// fires once the field loses focus, which never happens if the tab is reloaded or
// closed straight after pasting, and losing a freshly pasted token is the whole
// annoyance this is here to avoid.
const remember = (key) => localStorage.setItem(`repro.${key}`, ui[key].value.trim());

['token', 'destination'].forEach((key) => {
  ui[key].value = localStorage.getItem(`repro.${key}`) || (key === 'destination' ? '/public/' : '');
  ui[key].addEventListener('input', () => remember(key));
});

/**
 * Find the enumerated device the browser labels as the machine default for a kind.
 *
 * Chrome publishes a synthetic entry with `deviceId === 'default'` that follows whatever
 * the OS is currently using. Pinning to that entry rather than to a hardware id means the
 * PoC always uses the same thing the rest of the machine does, so logs stay comparable and
 * nobody has to work out which of several microphones "loke Microphone" was.
 * @param {MediaDeviceKind} kind
 * @returns {Promise<MediaDeviceInfo|null>}
 */
async function findDefaultDevice(kind) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find((device) => device.kind === kind && device.deviceId === 'default') ?? null;
}

/**
 * Point the SDK and our own playback element at the machine default for audio in and out.
 *
 * Input goes through `selectAudioInputDevice`, which is public and feeds the SDK's own
 * constraint resolution: `deviceInfoToConstraints` turns the selection into
 * `{deviceId: {exact: 'default'}}` and that wins over anything passed to `dial()`. Output is
 * set twice on purpose: the SDK is told, and `setSinkId` is called on the element this page
 * owns, because the page binds `remoteStream$` to its own `<video>` and the SDK never sees it.
 *
 * Best effort throughout. Device labels and ids are only complete once a capture has been
 * granted, so with `?nowarm=1` there may be nothing to pin yet, and that is fine: the test
 * that flag exists for does not care which microphone answers.
 */
async function useDefaultAudioDevices() {
  // The SDK resolves a selection against its OWN enumerated list and quietly pins nothing
  // when that list is still empty, so make sure it has one before choosing.
  try {
    await client.enumerateDevices();
  } catch (error) {
    log(`device enumeration failed: ${error?.name}: ${error?.message}`, 'warn');
  }

  const [input, output] = await Promise.all([findDefaultDevice('audioinput'), findDefaultDevice('audiooutput')]);

  if (publishOwnTone) {
    log('not pinning an audio input: this page publishes a tone instead of opening a microphone');
  } else if (input) {
    client.selectAudioInputDevice(input);
    log(`audio in pinned to the machine default: "${input.label || 'unlabelled'}"`);
  } else {
    log('no "default" audio input published by the browser; leaving the SDK to choose', 'warn');
  }

  if (output) {
    client.selectAudioOutputDevice(output);
    log(`audio out pinned to the machine default: "${output.label || 'unlabelled'}"`);
  }

  // Independent of the SDK: this element is ours, so its sink is ours to set.
  try {
    await ui.remote.setSinkId?.('default');
  } catch (error) {
    log(`could not set the playback sink: ${error?.name}: ${error?.message}`, 'warn');
  }
}

/**
 * Open the microphone and camera before dialling, and hand back the capture so it
 * can be held open until the dial has finished.
 *
 * The SDK races call setup against a hardcoded 6 second budget
 * (`ClientSessionManager.callCreateTimeout`, not configurable) and runs its own
 * getUserMedia inside that budget. A device that is slow to wake therefore spends
 * the budget on opening and the dial fails with "Call create timeout" with nothing
 * actually wrong: an LG UltraFine display camera took 6.7s and lost the race by
 * 700ms. Opening the devices first moves that cost outside the budget, and keeping
 * the capture running means the SDK's own request lands on a device that is already
 * open and returns straight away.
 *
 * A failure here is not fatal. The SDK is about to ask for the same devices and can
 * report the problem itself, so this only ever gives up its head start.
 * @returns {Promise<MediaStream|null>} The warm capture, or null if it could not be taken
 */
async function warmDevices() {
  try {
    // Warming the same device the call will use is the whole point; warming a different
    // one leaves the call's own capture cold and the head start is wasted. `exact` is
    // required: a bare `deviceId: 'default'` is only an ideal, and Chrome was observed
    // ignoring it and opening a different microphone than the call went on to use.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: 'default' } },
      video: true
    });
    log('devices open, dialling with them held');
    return stream;
  } catch (error) {
    log(`could not open the devices first: ${error?.name}: ${error?.message}`, 'warn');
    return null;
  }
}

function setJoined(joined) {
  ui.join.disabled = joined;
  ui.leave.disabled = !joined;
  [
    ui.mic,
    ui.video,
    ui.screen,
    ui.extraAudio,
    ui.dropSocket,
    ui.dropOnPing,
    ui.dropBeforePing,
    ui.swallowPong
  ].forEach((b) => (b.disabled = !joined));
  // Never enabled by joining: participants$ enables it once a device member exists to remove.
  ui.removeExtra.disabled = !joined || !childLegs.length;
}

// ---- join / leave ----------------------------------------------------------
ui.join.addEventListener('click', async () => {
  const token = ui.token.value.trim();
  const destination = ui.destination.value.trim();
  if (!token || !destination) return log('a token and a destination are both needed', 'bad');

  // Belt and braces: a value put in the field by autofill or by devtools never
  // fires `input`, so persist whatever is actually being joined with.
  ['token', 'destination'].forEach(remember);

  ui.join.disabled = true;
  let warmCapture = null;
  try {
    // Nothing to warm when no device is opened at all.
    warmCapture = skipWarm || publishOwnTone ? null : await warmDevices();
    client = new SignalWire(new StaticCredentialProvider({ token }));
    await useDefaultAudioDevices();
    const dialOptions = {
      audio: true,
      video: true,
      receiveAudio: true,
      receiveVideo: true
    };

    if (publishOwnTone) {
      // `audio` and `video` stay true: supplying the streams is what skips getUserMedia, while
      // the flags are what get a send-capable transceiver negotiated for each. The card is not
      // decoration either - the server composite only allocates a tile to a member whose video
      // transceiver was negotiated, so a tone with no card is heard and never seen.
      dialOptions.inputAudioStream = makeToneStream(OWN_LEG_TONE_HZ, 'own-leg tone');
      dialOptions.inputVideoStream = makeCardStream(`own leg ${OWN_LEG_TONE_HZ} Hz`);
      log(`publishing a ${OWN_LEG_TONE_HZ} Hz tone on this page's own leg, in place of the microphone`, 'warn');
      log('no getUserMedia should appear below this line; if one does, the control is polluted', 'warn');
    }

    log(`dialling ${destination}`);
    call = await client.dial(destination, dialOptions);

    call.status$.subscribe((status) => log(`call ${status}`));
    call.localStream$.subscribe((stream) => (ui.local.srcObject = stream));
    call.remoteStream$.subscribe((stream) => {
      ui.remote.srcObject = stream;
      // Probed only after it is bound to the element above. Chrome stops pumping a remote
      // stream that nothing plays, and an unplayed stream measures as silence, which looks
      // exactly like the tone not being there.
      watchTones(stream, WATCHED_TONES);
    });
    // errors$ carries a CallError wrapper ({ kind, fatal, error, callId, leg?, legId? }), not an
    // Error, so the cause is on .error. Only a fatal one ends the call from the client side.
    call.errors$.subscribe(({ kind, fatal, error, leg, legId }) => {
      const cause = error ? `${error.name}: ${error.message}` : 'no cause';
      const where = leg ? ` leg=${leg}${legId ? `/${legId}` : ''}` : '';
      log(`call error (${fatal ? 'FATAL' : 'non-fatal'}, kind=${kind}${where}): ${cause}`, fatal ? 'bad' : 'warn');
    });

    // The trigger. The payload is the constraints the server wants applied, and
    // it is what the SDK turns into a getUserMedia call moments later.
    call.mediaParamsUpdated$.subscribe((event) =>
      log(`verto.mediaParams ${JSON.stringify({ audio: event.audio, video: event.video })}`, 'warn')
    );

    // self$ emits on every member update, so subscribing to screenShareStatus$ inside it
    // without tearing the previous subscription down stacks one subscription per update and
    // the status line prints once per subscription. Keep exactly one, and log changes only.
    let lastShareStatus = null;
    call.self$.subscribe((self) => {
      shareStatusSub?.unsubscribe();
      shareStatusSub = null;
      if (!self) return;
      shareStatusSub = self.screenShareStatus$?.subscribe((status) => {
        if (status === lastShareStatus) return;
        lastShareStatus = status;
        log(`screen share ${status}`);
      });
    });

    // The handle removeAdditionalDevice() takes is the member's call id, and the public
    // surface only offers it here: an additional device turns up as a participant of type
    // "device". The server names it after the member who opened it, so a name cannot tell one
    // participant's device from another's. The parent_id that can is on the raw member
    // payload, which instrument.js logs straight off the socket.
    call.participants$.subscribe((participants) => {
      const devices = participants.filter((participant) => participant.type === 'device' && participant.callId);

      devices
        .filter((device) => !childLegs.some((leg) => leg.id === device.id))
        .forEach((device) => {
          childLegs.push({ id: device.id, callId: device.callId });
          log(`additional device in the room: member ${device.id}, call ${device.callId}`, 'warn');
        });

      childLegs = childLegs.filter((leg) => devices.some((device) => device.id === leg.id));
      ui.removeExtra.disabled = !childLegs.length;
    });

    setJoined(true);
    log('joined', 'good');
  } catch (error) {
    log(`join failed: ${error?.name}: ${error?.message}`, 'bad');
    // A failed dial leaves the client connected: the WebSocket keeps answering pings
    // for as long as the page is open, and a retry stacks another session on top.
    try {
      await client?.disconnect();
    } catch (disconnectError) {
      log(`disconnect after a failed join failed: ${disconnectError?.message}`, 'warn');
    }
    client = null;
    ui.join.disabled = false;
  } finally {
    // The SDK is holding its own capture by now, so this one has done its job.
    warmCapture?.getTracks().forEach((track) => track.stop());
  }
});

ui.leave.addEventListener('click', async () => {
  try {
    await call?.hangup();
  } catch (error) {
    log(`hangup failed: ${error?.message}`, 'warn');
  }
  shareStatusSub?.unsubscribe();
  shareStatusSub = null;
  stopWatchingTones();
  call = null;
  client = null;
  sharing = false;
  childLegs = [];
  setJoined(false);
  log('left');
});

// ---- mic / video -----------------------------------------------------------
// Each toggle is a member-scoped RPC (call.mute, call.unmute, call.video_mute, ...), so its
// outcome is logged with the elapsed time: after a socket reconnect these are the requests
// that show the server still serving the member while it refuses new legs.
async function loggedMemberOp(name, run) {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  log(`${name}()`);
  try {
    await run();
    log(`${name}() resolved in ${elapsed()}ms`, 'good');
    return true;
  } catch (error) {
    log(`${name}() FAILED after ${elapsed()}ms: ${error?.name}: ${error?.message}`, 'bad');
    return false;
  }
}

ui.mic.addEventListener('click', async () => {
  const self = call?.self;
  if (!self) return;
  await loggedMemberOp(self.audioMuted ? 'self.unmute' : 'self.mute', () =>
    self.audioMuted ? self.unmute() : self.mute()
  );
  ui.mic.textContent = `Mic: ${self.audioMuted ? 'off' : 'on'}`;
  ui.mic.classList.toggle('active', self.audioMuted);
});

ui.video.addEventListener('click', async () => {
  const self = call?.self;
  if (!self) return;
  await loggedMemberOp(self.videoMuted ? 'self.unmuteVideo' : 'self.muteVideo', () =>
    self.videoMuted ? self.unmuteVideo() : self.muteVideo()
  );
  ui.video.textContent = `Video: ${self.videoMuted ? 'off' : 'on'}`;
  ui.video.classList.toggle('active', self.videoMuted);
});

// ---- screen share ----------------------------------------------------------
// startScreenShare() takes no options and always asks getDisplayMedia for video
// alone, so the browser never offers to share the sound. Going through the verto
// manager is the only way to ask for it, which is half the report: there is no
// supported way to share screen audio at all.
ui.screen.addEventListener('click', async () => {
  const self = call?.self;
  if (!self) return;

  if (sharing) {
    await self.stopScreenShare();
    sharing = false;
    ui.screen.textContent = 'Share screen';
    ui.screen.classList.remove('active');
    return;
  }

  try {
    const vertoManager = self.vertoManager;
    if (useSupportedShareApi) {
      log('sharing via the supported startScreenShare(), which cannot ask for audio', 'warn');
      await self.startScreenShare();
    } else if (vertoManager?.addScreenMedia) {
      log('sharing with audio: true (via vertoManager.addScreenMedia)');
      await vertoManager.addScreenMedia({ audio: true });
    } else {
      log('SDK internals moved; sharing without audio via startScreenShare()', 'warn');
      await self.startScreenShare();
    }
    sharing = true;
    ui.screen.textContent = 'Stop sharing';
    ui.screen.classList.add('active');
  } catch (error) {
    log(`screen share failed: ${error?.name}: ${error?.message}`, 'bad');
  }
});

// ---- drop the socket -------------------------------------------------------
// Forces a signal-only reconnect. The WebSocket is closed from the client side, the SDK
// reconnects with its stored authorization_state, and the peer connection never notices.
// Watch the log for "CallRecoveryManager: signal-only reconnect", then try to share.
ui.dropSocket.addEventListener('click', () => {
  if (!call) return;
  dropSocket();
});

// ---- time the drop against verto.ping ---------------------------------------
// Reproduction 8. The server pings every call on a fixed cadence and, it seems, hangs up a
// call whose ping goes unanswered. Each button arms one way of losing a single answer; the
// plain Drop socket above, pressed midway between pings, is the control.
// Run J: the checkbox adds a resend of the lost pong to whichever variant is armed.
ui.dropOnPing.addEventListener('click', () => {
  if (call) dropSocketOnNextPing({ resendPong: ui.resendPong.checked });
});
ui.dropBeforePing.addEventListener('click', () => {
  if (call) dropSocketBeforeNextPing({ resendPong: ui.resendPong.checked });
});
ui.swallowPong.addEventListener('click', () => {
  if (call) swallowNextPong({ resendPong: ui.resendPong.checked });
});

// ---- the extra audio track -------------------------------------------------
/**
 * A steady tone, so silence is obvious and so is a swap.
 * @param {number} hz The frequency, which is how a tone in the received mix is attributed
 * @param {string} name What to call it in the log
 * @returns {MediaStream}
 */
function makeToneStream(hz, name) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();

  oscillator.frequency.value = hz;
  gain.gain.value = 0.12;
  oscillator.connect(gain).connect(destination);
  oscillator.start();

  markSupplied(destination.stream.getAudioTracks()[0], name);
  return destination.stream;
}

/** A labelled card, so the leg gets a tile in the composite and is easy to spot. */
function makeCardStream(text) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const context = canvas.getContext('2d');
  context.fillStyle = '#1d2027';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#e6e8ec';
  context.font = '36px sans-serif';
  context.textAlign = 'center';
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  return canvas.captureStream(1);
}

ui.extraAudio.addEventListener('click', async () => {
  const self = call?.self;
  if (!self?.addAdditionalDevice) return;

  extraAttempts += 1;
  const name = `tone ${extraAttempts}`;
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  // Every answered invite has landed between 5.6s and 5.9s end to end, so the elapsed time
  // separates the two outcomes as clearly as the outcome itself does. An unanswered one sits
  // until the SDK's 50s initAdditionalPeerConnection timeout fires.
  const tally = () => `${extraAnswered}/${extraAttempts} answered`;

  // `audio: false` with a stream supplied is deliberate: the leg already has its
  // audio, so there is nothing for the SDK to resolve microphone constraints for.
  const options = {
    audio: false,
    video: false,
    inputAudioStream: makeToneStream(CHILD_LEG_TONE_HZ, name),
    inputVideoStream: makeCardStream(name)
  };

  log(`adding an extra leg carrying "${name}" (attempt ${extraAttempts})`);
  try {
    await self.addAdditionalDevice(options);
    extraAnswered += 1;
    log(`extra leg "${name}" ANSWERED in ${elapsed()}ms. ${tally()}.`, 'good');
  } catch (error) {
    log(`extra leg "${name}" FAILED after ${elapsed()}ms: ${error?.name}: ${error?.message}. ${tally()}.`, 'bad');
  }
});

// ---- remove the extra leg --------------------------------------------------
// The other half of the reproduction-7 A/B: closing the leg takes its tone back out of the
// mix this member receives, which is what says the probe is tracking the leg and not some
// artefact of the page. Removes the most recent device member in the room, so only one
// browser in the run should be adding them.
ui.removeExtra.addEventListener('click', async () => {
  const self = call?.self;
  const leg = childLegs[childLegs.length - 1];
  if (!self?.removeAdditionalDevice || !leg) return;

  await loggedMemberOp(`self.removeAdditionalDevice(${leg.callId})`, () => self.removeAdditionalDevice(leg.callId));
});

// ---- log controls ----------------------------------------------------------
el('clear-log').addEventListener('click', () => (el('log').textContent = ''));
el('copy-log').addEventListener('click', () => navigator.clipboard.writeText(el('log').textContent));

log(`ready. SDK ${version}`);
if (skipWarm) log('?nowarm: dialling without warming the devices first', 'warn');
if (useSupportedShareApi) log('?supportedapi: screen share will use startScreenShare()', 'warn');
if (publishOwnTone) log(`?maintone: joining with a ${OWN_LEG_TONE_HZ} Hz tone instead of a microphone`, 'warn');

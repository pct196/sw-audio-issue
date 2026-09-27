/*
 * Observation only. Nothing here changes what the SDK does; it just records it.
 *
 * Four native things are wrapped:
 *   1. RTCPeerConnection  - so every peer connection the SDK builds can be enumerated.
 *   2. getUserMedia / getDisplayMedia - so every capture the SDK asks for is logged.
 *   3. MediaStreamTrack.stop - so we can see who stops a track, and where from.
 *   4. WebSocket - so the frames that matter are logged verbatim: inbound verto.mediaParams,
 *      outbound verto.invite, inbound JSON-RPC errors, inbound verto.attach, inbound member
 *      payloads that carry a parent_id, inbound verto.bye and call.left, every verto.ping
 *      and the verto.pong that answers it, and the socket's open and close events. DevTools
 *      collapses object arguments to {...} in a saved log, which leaves the payload of every
 *      frame the SDK logs invisible; this prints them as strings so they survive.
 *
 * A 1s poller then reports, on change only, which track each audio sender is holding.
 * That is where the defect shows: a track this page supplied is stopped and the sender
 * ends up holding a different one that nobody on this page asked for.
 *
 * A narrowband probe on the received stream then reports which of the tones this page
 * publishes are in the mix the server sends back to this member. That is the whole of
 * reproduction 7: a member's own additional device comes back to it.
 *
 * Exceptions to "observation only", each called only from its button: dropSocket() closes
 * the SDK's live WebSocket on purpose, to force a signal-only reconnect, and reproduction 8
 * times that close against the verto.ping keepalive or swallows one verto.pong outright.
 */
(function () {
  'use strict';

  const logEl = () => document.getElementById('log');
  const peerConnections = [];

  // Tracks this page created and handed to the SDK, by id.
  const suppliedTracks = new Map();

  const short = (id) => (id ? String(id).slice(0, 8) : 'none');

  function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function log(message, level) {
    const line = `${stamp()}  ${message}`;
    const el = logEl();
    if (el) {
      const span = document.createElement('span');
      if (level) span.className = level;
      span.textContent = line + '\n';
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.appendChild(span);
      if (atBottom) el.scrollTop = el.scrollHeight;
    }
    const method = level === 'bad' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](`[repro] ${line}`);
  }

  function describeTrack(track) {
    if (!track) return 'no track';
    const supplied = suppliedTracks.has(track.id) ? ` SUPPLIED:${suppliedTracks.get(track.id)}` : '';
    return `${track.kind}/${short(track.id)} "${track.label || 'unlabelled'}" ${track.readyState}${supplied}`;
  }

  /** Mark a track as one this page created, so the log can call it out by name. */
  function markSupplied(track, name) {
    if (!track) return track;
    suppliedTracks.set(track.id, name);
    log(`supplied ${describeTrack(track)}`, 'good');
    track.addEventListener('ended', () => log(`SUPPLIED TRACK ENDED ${describeTrack(track)}`, 'bad'));
    track.addEventListener('mute', () => log(`supplied track muted ${describeTrack(track)}`, 'warn'));
    return track;
  }

  // ---- 1. record every peer connection -------------------------------------
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePC, {
    construct(target, args) {
      const pc = new target(...args);
      peerConnections.push(pc);
      log(`RTCPeerConnection #${peerConnections.length} created`, 'dim');
      pc.addEventListener('connectionstatechange', () =>
        log(`pc#${peerConnections.indexOf(pc) + 1} ${pc.connectionState}`, 'dim')
      );
      return pc;
    }
  });

  // ---- 2. log every capture ------------------------------------------------
  const md = navigator.mediaDevices;
  const nativeGUM = md.getUserMedia.bind(md);
  const nativeGDM = md.getDisplayMedia.bind(md);

  md.getUserMedia = async (constraints) => {
    log(`getUserMedia(${JSON.stringify(constraints)})`, 'warn');
    try {
      const stream = await nativeGUM(constraints);
      stream.getTracks().forEach((t) => log(`  gUM gave ${describeTrack(t)}`, 'dim'));
      return stream;
    } catch (error) {
      log(`  gUM REJECTED ${error.name}: ${error.message}`, 'bad');
      throw error;
    }
  };

  md.getDisplayMedia = async (constraints) => {
    log(`getDisplayMedia(${JSON.stringify(constraints)})`, 'warn');
    const stream = await nativeGDM(constraints);
    stream.getTracks().forEach((t) => log(`  gDM gave ${describeTrack(t)}`, 'dim'));
    if (!stream.getAudioTracks().length) {
      log('  no audio track was granted: tick "Also share tab audio" in the picker', 'warn');
    }
    return stream;
  };

  // ---- 3. log every stop ---------------------------------------------------
  const nativeStop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    const caller = (new Error().stack || '').split('\n')[2] || '';
    const level = suppliedTracks.has(this.id) ? 'bad' : 'dim';
    log(`track.stop() ${describeTrack(this)} from${caller.replace(/^\s*at\s*/, ' ')}`, level);
    return nativeStop.call(this);
  };

  // ---- 4. log the WebSocket frames that matter ------------------------------
  // The server's verto.mediaParams payload is what triggers the track swap, but on a leg
  // where the swap throws the SDK never re-emits it, and DevTools saves its own log of the
  // frame as {...}. So read it straight off the socket. The same goes for the frames the
  // reconnect test needs: the outbound verto.invite (what the client asked for on a new
  // leg), any inbound JSON-RPC error (so a rejection's code and message sit side by side),
  // any inbound verto.attach (a server-side re-bind after a reconnect, if one ever comes),
  // and the socket's open and close events, which the SDK does not log when it intends
  // to reconnect. Verto messages usually arrive nested inside a signalwire.event
  // envelope, hence the recursive searches.
  function findMethod(node, name) {
    if (!node || typeof node !== 'object') return null;
    if (node.method === name) return node;
    for (const value of Object.values(node)) {
      const found = findMethod(value, name);
      if (found) return found;
    }
    return null;
  }

  /**
   * The first member payload in a frame that names a parent.
   *
   * An additional device and a screen share both arrive as a member whose `parent_id` is the
   * member that opened it, and that relationship is the subject of reproduction 7. Five fields
   * are picked rather than the whole payload: the rest is the account's own identifiers
   * (`subscriber_id`, `address_id`) and has nothing to do with it.
   */
  function findChildMember(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.member_id && node.parent_id) {
      const { member_id, call_id, parent_id, type, name } = node;
      return { member_id, call_id, parent_id, type, name };
    }
    for (const value of Object.values(node)) {
      const found = findChildMember(value);
      if (found) return found;
    }
    return null;
  }

  function findError(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.error && typeof node.error === 'object') return node.error;
    for (const value of Object.values(node)) {
      const found = findError(value);
      if (found) return found;
    }
    return null;
  }

  /**
   * A copy of a frame with every string-valued `sdp` replaced by its length. An SDP carries
   * every ICE candidate, so the LAN and public addresses of the machine; the log needs the
   * fact that one was sent, not its contents. Applied to outbound invites and to inbound
   * error frames, which echo the whole rejected request under `error.original_request`.
   */
  function redactSdp(node) {
    if (Array.isArray(node)) return node.map(redactSdp);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === 'sdp' && typeof value === 'string' ? `<${value.length} chars>` : redactSdp(value);
    }
    return out;
  }

  /** The first frame whose event_type is `call.left`, so the hang-up is read off the wire. */
  function findCallLeft(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.event_type === 'call.left') return node;
    for (const value of Object.values(node)) {
      const found = findCallLeft(value);
      if (found) return found;
    }
    return null;
  }

  let liveSocket = null;
  let socketCount = 0;
  const childMembers = new Set();

  // ---- 4b. the verto.ping keepalive -----------------------------------------
  /*
   * The server sends verto.ping on a fixed cadence (46s in every run so far) and the SDK
   * answers each one with a verto.pong: a new request with its own id, wrapped in
   * webrtc.verto, carrying the ping's params. The pong does not echo the ping's id, so pings
   * and pongs are paired in order, and the server's ack is matched on the pong's outer id.
   *
   * Reproduction 8 is a call hung up about one ping interval after a ping went unanswered,
   * so everything here is about saying which ping was answered, on which socket, in what
   * state, and whether the server acknowledged the answer.
   */
  const ping = {
    last: 0, // when the last verto.ping arrived, ms since epoch
    interval: 0, // the gap between the last two, once there have been two
    count: 0,
    unanswered: [], // { n, id, at, socket }, in arrival order
    awaitingAck: new Map(), // pong's outer request id -> { entry, sentAt }
    overdueLogged: false,
    armedDropOnPing: false,
    armedSwallow: false,
    dropTimer: null
  };

  function describeState(socket) {
    return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socket.readyState] ?? String(socket.readyState);
  }

  function onPing(verto, socket, n) {
    const now = Date.now();
    const gap = ping.last ? now - ping.last : 0;
    if (ping.last) ping.interval = gap;
    ping.last = now;
    ping.overdueLogged = false;
    const entry = { n: ++ping.count, id: verto.id, at: now, socket: n };
    ping.unanswered.push(entry);
    const when = gap ? `${(gap / 1000).toFixed(1)}s after the last` : 'the first';
    const params = JSON.stringify(verto.params ?? {});
    log(`verto.ping #${entry.n} id=${verto.id} on WebSocket #${n}, ${when}: ${params}`, 'dim');
    // This listener was added in the constructor, ahead of the SDK's own, so closing here
    // happens before the SDK has seen the ping. It then answers into a closing socket.
    if (ping.armedDropOnPing) {
      ping.armedDropOnPing = false;
      log(`dropping WebSocket #${n} as verto.ping #${entry.n} lands, before the SDK can answer it`, 'warn');
      socket.close();
    }
    // Generous: every answer seen so far went out within a few milliseconds.
    setTimeout(() => {
      if (ping.unanswered.includes(entry)) log(`verto.ping #${entry.n} id=${entry.id} not answered after 5s`, 'bad');
    }, 5000);
  }

  /**
   * An outbound frame carrying verto.pong. Returns false when the page swallows it.
   * @param {object} frame The whole outbound request
   * @param {WebSocket} socket The socket it is being sent on
   * @param {number} n That socket's number
   * @returns {boolean} Whether to send it
   */
  function onPong(frame, socket, n) {
    const entry = ping.unanswered.shift();
    const which = entry
      ? `verto.ping #${entry.n} (id=${entry.id}, arrived on WebSocket #${entry.socket})`
      : 'no pending verto.ping';
    if (ping.armedSwallow) {
      ping.armedSwallow = false;
      log(`SWALLOWED the verto.pong for ${which}: never sent. The socket stays open`, 'warn');
      return false;
    }
    const state = describeState(socket);
    const delay = entry ? `, ${Date.now() - entry.at}ms after the ping` : '';
    log(`verto.pong for ${which} sent on WebSocket #${n} (${state})${delay}`, socket.readyState === 1 ? 'dim' : 'bad');
    if (socket.readyState !== 1) log(`  ^ the browser discards a send on a ${state} socket, without an error`, 'bad');
    ping.awaitingAck.set(frame.id, { entry, sentAt: Date.now() });
    return true;
  }

  /** An inbound frame answering one of the pongs above. */
  function onPongReply(frame) {
    const pending = ping.awaitingAck.get(frame.id);
    if (!pending) return;
    ping.awaitingAck.delete(frame.id);
    const label = pending.entry ? `verto.ping #${pending.entry.n}` : 'an unmatched ping';
    const outcome = frame.error ? `REJECTED: ${JSON.stringify(frame.error)}` : 'acknowledged by the server';
    log(`verto.pong for ${label} ${outcome} in ${Date.now() - pending.sentAt}ms`, frame.error ? 'bad' : 'dim');
  }

  /*
   * The first few frames the SDK sends on each socket, and any send on a socket that is not
   * OPEN. In both drop-on-ping runs the server closed the first replacement socket with
   * 1003 "Received response, expected request" before signalwire.connect was answered, so
   * something went out ahead of it. Only the shape is logged (method or reply-to id), never
   * params: signalwire.connect carries the token.
   */
  const FIRST_FRAMES_LOGGED = 3;

  /**
   * One outbound frame as a short label: `request <method> [> <inner method>] id=...` or
   * `RESULT for id=...` / `ERROR for id=...` when it is a reply.
   * @param {object} frame A parsed JSON-RPC frame
   * @returns {string}
   */
  function describeFrame(frame) {
    if (!frame.method) return `${'error' in frame ? 'ERROR' : 'RESULT'} for id=${frame.id}`;
    const inner = frame.params?.message?.method;
    return `request ${frame.method}${inner ? ` > ${inner}` : ''} id=${frame.id}`;
  }

  function onSocketClosed(n) {
    ping.unanswered
      .filter((entry) => entry.socket === n)
      .forEach((entry) =>
        log(`verto.ping #${entry.n} id=${entry.id} was still unanswered when WebSocket #${n} closed`, 'bad')
      );
  }

  // The countdown, and a watchdog for a ping that never comes: in the run behind
  // reproduction 8 no verto.ping arrived on the new socket at all before the hang-up.
  setInterval(() => {
    const el = document.getElementById('ping-due');
    let text;
    if (!ping.last) {
      text = 'no verto.ping yet';
    } else if (!ping.interval) {
      text = `1 verto.ping so far, ${((Date.now() - ping.last) / 1000).toFixed(0)}s ago`;
    } else {
      const due = ping.last + ping.interval - Date.now();
      const every = `every ${(ping.interval / 1000).toFixed(1)}s`;
      text =
        due >= 0
          ? `next verto.ping due in ${(due / 1000).toFixed(1)}s (${every})`
          : `verto.ping ${(-due / 1000).toFixed(1)}s overdue (${every})`;
      if (due < -5000 && !ping.overdueLogged) {
        ping.overdueLogged = true;
        log(`verto.ping overdue: none for ${((Date.now() - ping.last) / 1000).toFixed(1)}s, ${every}`, 'bad');
      }
    }
    if (el) el.textContent = text;
  }, 250);

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const socket = new target(...args);
      const n = ++socketCount;
      liveSocket = socket;
      log(`WebSocket #${n} connecting`, 'dim');
      socket.addEventListener('open', () => log(`WebSocket #${n} open`, 'dim'));
      socket.addEventListener('close', (event) => {
        log(`WebSocket #${n} closed code=${event.code} reason="${event.reason}" clean=${event.wasClean}`, 'warn');
        onSocketClosed(n);
      });

      const nativeSend = socket.send.bind(socket);
      let framesSent = 0;
      socket.send = (data) => {
        if (typeof data === 'string') {
          let frame = null;
          try {
            frame = JSON.parse(data);
          } catch {
            /* not JSON, not ours */
          }
          if (frame) {
            framesSent += 1;
            const open = socket.readyState === NativeWS.OPEN;
            if (framesSent <= FIRST_FRAMES_LOGGED || !open) {
              const state = open ? '' : ` while ${describeState(socket)}`;
              log(`WebSocket #${n} send #${framesSent}${state}: ${describeFrame(frame)}`, open ? 'dim' : 'bad');
            }
            const invite = findMethod(frame, 'verto.invite');
            if (invite) log(`verto.invite frame to WebSocket: ${JSON.stringify(redactSdp(invite))}`, 'warn');
            if (findMethod(frame, 'verto.pong') && !onPong(frame, socket, n)) return undefined;
          }
        }
        return nativeSend(data);
      };

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return; /* not JSON, not ours */
        }
        const mediaParams = findMethod(frame, 'verto.mediaParams');
        if (mediaParams) log(`verto.mediaParams frame from WebSocket: ${JSON.stringify(mediaParams)}`, 'warn');
        const attach = findMethod(frame, 'verto.attach');
        if (attach) log(`verto.attach frame from WebSocket: ${JSON.stringify(attach)}`, 'warn');
        const vertoPing = findMethod(frame, 'verto.ping');
        if (vertoPing) onPing(vertoPing, socket, n);
        onPongReply(frame);
        // The hang-up, verbatim: a bye's cause and causeCode are on the wire even where the
        // SDK does not pass them on.
        const bye = findMethod(frame, 'verto.bye');
        if (bye) log(`verto.bye frame from WebSocket #${n}: ${JSON.stringify(bye)}`, 'bad');
        const left = findCallLeft(frame);
        if (left) log(`call.left frame from WebSocket #${n}: ${JSON.stringify(left)}`, 'bad');
        // Once per member: the same child turns up again in every member.updated and in the
        // room snapshot, and the relationship only needs saying once.
        const child = findChildMember(frame);
        if (child && !childMembers.has(child.member_id)) {
          childMembers.add(child.member_id);
          log(`child member from WebSocket: ${JSON.stringify(child)}`, 'warn');
        }
        if (findError(frame)) log(`error frame from WebSocket: ${JSON.stringify(redactSdp(frame))}`, 'bad');
      });
      return socket;
    }
  });

  /**
   * The one deliberate action in this file. Closes the SDK's live WebSocket from the
   * client side. The SDK's close handler schedules a reconnect and the peer connection is
   * never touched, so the result is a signal-only reconnect by construction. A client-side
   * close sends code 1000 where a real network drop would be 1006; if the server treats
   * the two differently, a short wifi toggle is the fallback.
   */
  function dropSocket() {
    if (!liveSocket || liveSocket.readyState !== NativeWS.OPEN) {
      log('no open WebSocket to drop', 'warn');
      return false;
    }
    log('dropping the live WebSocket on purpose (client-side close, code 1000)', 'warn');
    liveSocket.close();
    return true;
  }

  /*
   * Reproduction 8's three actions. Like dropSocket() they change what happens rather than
   * observe it, and only the buttons call them.
   */

  /** Close the socket the moment the next verto.ping arrives, before the SDK can answer it. */
  function dropSocketOnNextPing() {
    ping.armedDropOnPing = true;
    log('armed: the socket closes as the next verto.ping lands', 'warn');
  }

  /**
   * Close the socket shortly before the next verto.ping is due, so the server sends it into
   * the gap. Closer to a real network blip than dropSocketOnNextPing().
   * @param {number} leadMs How long before the predicted ping to close
   */
  function dropSocketBeforeNextPing(leadMs = 300) {
    if (!ping.interval) {
      log('need two verto.pings first, to know when the next one is due', 'warn');
      return false;
    }
    clearTimeout(ping.dropTimer);
    let wait = ping.last + ping.interval - leadMs - Date.now();
    // Already past this one's drop point: aim at the one after.
    if (wait < 0) wait += ping.interval;
    const inS = (wait / 1000).toFixed(1);
    log(`armed: the socket closes in ${inS}s, ${leadMs}ms before the next verto.ping is due`, 'warn');
    ping.dropTimer = setTimeout(() => {
      log(`closing ${leadMs}ms before the predicted verto.ping`, 'warn');
      dropSocket();
    }, wait);
    return true;
  }

  /** Discard the SDK's answer to the next verto.ping. No reconnect, the socket stays open. */
  function swallowNextPong() {
    ping.armedSwallow = true;
    log('armed: the answer to the next verto.ping is swallowed, the socket is left alone', 'warn');
  }

  // ---- 5. probe what comes back --------------------------------------------
  /*
   * A narrowband probe on a received stream, so the tones this page publishes can be
   * looked for in what the server sends back.
   *
   * Each tone is judged on two numbers: the peak level in a band around it, and how far
   * that peak stands above the spectrum's own median. It has to clear an absolute floor
   * AND a contrast margin, because either test alone is fooled: a loud room lifts every
   * bin, and a silent stream has plenty of contrast between nothing and nothing. Both
   * numbers are printed with every verdict, so a reader can disagree with the thresholds.
   *
   * A verdict has to hold for a full second before it is reported, which keeps a tone
   * sitting on the threshold from filling the log and rules out onset transients.
   *
   * Still observation only: the probe is a listener on a stream the page already has, it
   * is never connected to the speakers, and nothing it measures changes what the SDK does.
   */
  const TONE_FFT_SIZE = 8192; // 5.9 Hz per bin at 48 kHz
  const TONE_BAND_HZ = 18; // half-width of the band searched around each tone
  const TONE_SAMPLE_MS = 250;
  // Four, not two: run H caught a 500 ms broadband transient as the child leg's audio
  // entered the mix, which lifted the whole spectrum (floor -112 dB against the usual
  // -143) and read as 660 Hz at -55 dB, 23 dB under the real thing. What is being looked
  // for is a continuous tone, so requiring a full second of agreement costs nothing and
  // rules that out. The logs shipped for run H were captured at two.
  const TONE_CONFIRM_SAMPLES = 4;
  const TONE_FLOOR_DB = -75; // below this, nothing is a tone whatever the contrast
  const TONE_CONTRAST_DB = 25; // how far above the spectral median a tone has to stand
  const TONE_REPEAT_MS = 5000; // how often a tone that is still there is reported again

  const probe = {
    context: null,
    source: null,
    analyser: null,
    timer: null,
    spectrum: null,
    waveform: null,
    tones: []
  };

  const db = (value) => (Number.isFinite(value) ? value.toFixed(1) : '-inf');

  /** dBFS of the stream's broadband level, so "something is arriving" is visible too. */
  function broadbandDb() {
    probe.analyser.getFloatTimeDomainData(probe.waveform);
    let sum = 0;
    for (const sample of probe.waveform) sum += sample * sample;
    const rms = Math.sqrt(sum / probe.waveform.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  /** The median bin level: a floor that follows the stream instead of a fixed guess. */
  function spectralMedianDb() {
    const bins = Array.from(probe.spectrum, (value) =>
      Number.isFinite(value) ? value : probe.analyser.minDecibels
    );
    bins.sort((a, b) => a - b);
    return bins[bins.length >> 1];
  }

  /** The loudest bin within TONE_BAND_HZ of a frequency. */
  function bandPeakDb(hz) {
    const perBin = probe.context.sampleRate / probe.analyser.fftSize;
    const first = Math.max(0, Math.round((hz - TONE_BAND_HZ) / perBin));
    const last = Math.min(probe.spectrum.length - 1, Math.round((hz + TONE_BAND_HZ) / perBin));
    let peak = -Infinity;
    for (let bin = first; bin <= last; bin += 1) {
      if (probe.spectrum[bin] > peak) peak = probe.spectrum[bin];
    }
    return peak;
  }

  function renderToneReadout(level) {
    const el = document.getElementById('tone-readout');
    if (!el) return;
    el.textContent = '';
    if (!probe.timer) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = 'not probing';
      el.appendChild(span);
      return;
    }
    const chip = (text, state) => {
      const span = document.createElement('span');
      span.className = state ? `chip ${state}` : 'chip';
      span.textContent = text;
      el.appendChild(span);
    };
    chip(`received ${db(level)} dBFS`);
    probe.tones.forEach((tone) => {
      chip(`${tone.hz} Hz ${tone.reported ? 'PRESENT' : 'absent'} (${db(tone.peak)} dB)`, tone.reported ? 'on' : 'off');
    });
  }

  function sampleTones() {
    probe.analyser.getFloatFrequencyData(probe.spectrum);
    const floor = spectralMedianDb();
    const level = broadbandDb();

    probe.tones.forEach((tone) => {
      const peak = bandPeakDb(tone.hz);
      const present = peak >= TONE_FLOOR_DB && peak - floor >= TONE_CONTRAST_DB;
      tone.peak = peak;

      if (present === tone.raw) tone.streak += 1;
      else {
        tone.raw = present;
        tone.streak = 1;
      }

      const confirmed = tone.streak >= TONE_CONFIRM_SAMPLES ? present : tone.reported;
      const detail = `peak ${db(peak)} dB, floor ${db(floor)} dB, stream ${db(level)} dBFS`;

      if (confirmed !== tone.reported) {
        tone.reported = confirmed;
        tone.reportedAt = Date.now();
        log(
          confirmed
            ? `${tone.name} IS IN the stream this member receives: ${detail}`
            : `${tone.name} is gone from the stream this member receives: ${detail}`,
          confirmed ? 'warn' : 'dim'
        );
      } else if (confirmed && Date.now() - tone.reportedAt >= TONE_REPEAT_MS) {
        tone.reportedAt = Date.now();
        log(`${tone.name} still arriving: ${detail}`, 'dim');
      }
    });

    renderToneReadout(level);
  }

  /**
   * Start probing a stream, replacing any stream already being probed.
   *
   * Chrome only pumps a remote stream that something is playing, so the caller has to have
   * this stream bound to a media element first or the probe reads digital silence, which
   * looks exactly like a tone being absent.
   * @param {MediaStream|null} stream The received stream
   * @param {Array<{hz: number, name: string}>} tones The tones to look for
   */
  function watchTones(stream, tones) {
    stopWatchingTones();
    if (!stream?.getAudioTracks().length) {
      log('nothing to probe: the received stream carries no audio track', 'warn');
      return;
    }

    probe.context = probe.context || new AudioContext();
    // A context created before the page is clicked starts suspended, and a suspended
    // context's analyser reads silence forever.
    if (probe.context.state === 'suspended') probe.context.resume().catch(() => {});

    probe.analyser = probe.context.createAnalyser();
    probe.analyser.fftSize = TONE_FFT_SIZE;
    probe.analyser.smoothingTimeConstant = 0;
    probe.spectrum = new Float32Array(probe.analyser.frequencyBinCount);
    probe.waveform = new Float32Array(probe.analyser.fftSize);
    // Connected to the analyser and nowhere else. The page plays this stream through its
    // own element; a second path to the speakers would play everything twice.
    probe.source = probe.context.createMediaStreamSource(stream);
    probe.source.connect(probe.analyser);
    probe.tones = tones.map((tone) => ({
      ...tone,
      raw: null,
      streak: 0,
      reported: false,
      reportedAt: 0,
      peak: -Infinity
    }));
    probe.timer = setInterval(sampleTones, TONE_SAMPLE_MS);
    log(`probing the received stream for ${tones.map((tone) => `${tone.hz} Hz`).join(' and ')}`, 'dim');
  }

  /** Stop probing. Keeps the AudioContext, which is reused by the next stream. */
  function stopWatchingTones() {
    if (probe.timer) clearInterval(probe.timer);
    probe.timer = null;
    probe.source?.disconnect();
    probe.source = null;
    probe.analyser = null;
    probe.tones = [];
    renderToneReadout(-Infinity);
  }

  // ---- the poller ----------------------------------------------------------
  // Reports only when a sender's track changes, so the log stays readable.
  const lastSeen = new Map();

  setInterval(() => {
    peerConnections.forEach((pc, index) => {
      if (pc.connectionState === 'closed') return;
      pc.getSenders()
        .filter((sender) => sender.track?.kind === 'audio' || lastSeen.has(sender))
        .forEach((sender) => {
          const now = sender.track ? `${sender.track.id}:${sender.track.readyState}` : 'none';
          const before = lastSeen.get(sender);
          if (before === now) return;
          lastSeen.set(sender, now);
          if (before === undefined) {
            log(`pc#${index + 1} audio sender holds ${describeTrack(sender.track)}`, 'dim');
            return;
          }
          const wasSupplied = before !== 'none' && suppliedTracks.has(before.split(':')[0]);
          log(
            `pc#${index + 1} audio sender changed: ${short(before.split(':')[0])} -> ${describeTrack(sender.track)}`,
            wasSupplied ? 'bad' : 'warn'
          );
          if (wasSupplied) {
            log('  ^ the SDK replaced a track this page supplied. That leg is now sending something else.', 'bad');
          }
        });
    });
  }, 1000);

  window.repro = {
    log,
    describeTrack,
    markSupplied,
    dropSocket,
    dropSocketOnNextPing,
    dropSocketBeforeNextPing,
    swallowNextPong,
    watchTones,
    stopWatchingTones,
    peerConnections,
    suppliedTracks
  };
})();

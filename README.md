# SignalWire v4 defect reproductions

A minimal test page that reproduces several defects in the `@signalwire/js` v4
Call Fabric client. Plain HTML, CSS and JavaScript, no build step, no dependencies;
the published SDK bundle is loaded straight from jsDelivr.

The page currently loads `4.0.0-rc.3`. Every capture up to run H was taken
against `4.0.0-rc.2`, which is what the upstream issues up to #14 cite; change the import
at the top of `app.js` to go back to it.

## Run it

Needs `node` and `openssl` (media capture requires a secure context, so the page is
served over HTTPS with a self-signed certificate, generated on first run).

```sh
git clone https://github.com/pct196/sw-audio-issue.git
cd sw-audio-issue
node serve.mjs           # https://localhost:8443
```

Accept the certificate warning once. Then:

1. Open the page in two browsers (or one normal and one incognito window).
2. Paste the same v4 subscriber access token and destination (`/public/<room-name>`)
   from your SignalWire space into both. Both persist in localStorage.
3. Press **Join** in each.

Everything the page observes is logged to the on-page log and to the browser console
with a `[repro]` prefix. To capture a run: DevTools console, Verbose on, Preserve log
on, then right-click, Save as.

## The reproductions

### 1. Supplied audio is stopped, then the call is destroyed

Press **Add extra audio track (440 Hz tone)** in one browser. The page builds a 440 Hz
tone with Web Audio and hands it to
`self.addAdditionalDevice({ audio: false, video: false, inputAudioStream })`. Nothing
on the page touches that track afterwards.

Expected: the other browser hears a steady tone.

Actual: within about half a second of the leg connecting, the server pushes
`verto.mediaParams` to it, the SDK stops the supplied track and tries to re-acquire it
from `getUserMedia` with the old track's `deviceId` pinned as `{exact: "WebAudio-<uuid>"}`,
which no `getUserMedia` can satisfy. The rejection is classified fatal and the whole
call is torn down, main peer connection first:

```
track.stop() audio/... "MediaStreamAudioDestinationNode" live SUPPLIED:tone from ...replaceAudioTrackWithConstraints
getUserMedia({"audio":{...,"deviceId":{"exact":"WebAudio-..."}}})
  gUM REJECTED OverconstrainedError:
[RTCPeerConnectionController] Destroying RTCPeerConnectionController. main
call destroyed
```

### 2. Screen-share audio, same teardown

Press **Share screen**, pick a browser **tab**, tick **Also share tab audio** (Chrome
offers that checkbox for tabs only). Play something with sound in the shared tab.

Same sequence: the tab-audio track from `getDisplayMedia` reports
`deviceId: "web-contents-media-stream://..."`, the pinned re-capture rejects, the call
is destroyed.

Two notes:

- The page starts the share through `vertoManager.addScreenMedia({ audio: true })`,
  because the public `startScreenShare()` takes no options and only ever requests
  video. `?supportedapi=1` switches to `startScreenShare()` for comparison.
- Cancelling the picker is a useful control: only the share leg is destroyed and the
  call survives, which is the fix for issue #5 working. Sharing with audio reaches the
  same classifier through a different call site and destroys the call.

### 3. The `verto.mediaParams` frames themselves

The page logs every inbound `verto.mediaParams` WebSocket frame verbatim
(`verto.mediaParams frame from WebSocket: {...}`), so the payload the server sends to
each leg can be read directly. Legs carrying no microphone receive microphone
processing constraints (`autoGainControl`, `echoCancellation`, `noiseSuppression`);
the `deviceId` seen in the subsequent `getUserMedia` is not in the frame, it is merged
in by the SDK from the old track.

### 4. The 6s call-create timeout contains `getUserMedia`

Open the page with `?nowarm=1` (the page normally pre-warms the devices before
dialling, which hides this). Reset the site's camera and microphone permissions, press
**Join**, and leave the permission prompt unanswered for more than 6 seconds before
clicking Allow.

The join fails with `CallCreateError: Call create timeout` at exactly 6 seconds,
because the SDK's own `getUserMedia` runs inside the hardcoded `callCreateTimeout`.
The prompt's capture is not cancelled: the camera and microphone open after the
failure, for a call that no longer exists, and `addTransceiver` throws
`InvalidStateError`. The same failure occurs with no prompt when a camera is slow to
open.

### 5. `addAdditionalDevice` timing

Each **Add extra audio track** press logs the time from the call to the invite being
answered (`ANSWERED in <n>ms`). Every answered invite lands between 5.6s and 5.9s. An
invite that is never served produces no error frame; the first caller-visible failure
is a `TimeoutErrorImpl` 50 seconds later, from a timeout sized for the screen-share
picker.

### 6. New legs refused after a signal-only reconnect

Open the page with `?supportedapi=1`, so Share screen goes through the public
`startScreenShare()` with no audio and stays clear of reproductions 1 and 2. Join in two
browsers. In one of them press **Drop socket**: the page closes the SDK's WebSocket from
the client side, the SDK reconnects with its stored `authorization_state`, and because the
peer connection never dropped the log shows `CallRecoveryManager: signal-only reconnect`.
Toggle the mic once so a `call.mute` resolves on the new socket, then press **Share
screen**. Toggle it again after the share fails.

What to look for, all printed verbatim from the socket:

- `verto.invite frame to WebSocket` for the screen-share leg, with the SDP replaced by its
  length.
- `error frame from WebSocket` if the server rejects it, with the JSON-RPC `code` next to
  the `message`. The frame echoes the rejected request; its SDP is replaced by its length
  too, so the log never carries the machine's addresses.
- `self.mute() resolved in <n>ms` for each mic toggle: a member-scoped request served on the
  new socket, next to the invite the same socket had refused.
- `verto.attach frame from WebSocket` if the server ever re-binds the call after the
  reconnect. None has been seen.
- `WebSocket #n closed code=... reason=...` for every close, which the SDK itself does not
  log when it intends to reconnect.

Meanwhile share from the other browser, which did not reconnect, as the control. The share
you started and stopped before dropping the socket is the stronger control: same session,
same peer connection, and it works.

Reproduced three times out of three on 2026-09-11. `run-F-signal-only-reconnect-invite-refused.log`
is the capture: a share succeeds, the socket is dropped and reconnects as signal-only, the
same share is refused 253ms after the invite with `-32003` "Must provide a participant
invite first", the operation fails 50 seconds later, and a `call.unmute` on the new socket
after the refusal still resolves.

One caveat: a client-side close sends code 1000 where a real network drop sends 1006. If the
server treats the two differently, toggle wifi off for about a second instead; keep it short,
because ICE notices a longer outage and the SDK does a full reconnect, which is a different
path.

### 7. A member's own additional device is in the mix sent back to it

Open the page with `?maintone=1` in one browser. It dials with a 660 Hz tone as
`inputAudioStream` instead of opening a microphone, and because supplying a stream makes the
SDK skip `getUserMedia` altogether, no microphone and no camera are opened anywhere on the
machine. Every tone in the room is then one the page put there deliberately, and there is no
microphone to carry one from leg to leg acoustically.

Join, then press **Add extra audio track (440 Hz tone)**. The **Received audio** row probes
the stream from `call.remoteStream$` for both frequencies:

| Tone | Published by | In the mix this member receives |
|---|---|---|
| 660 Hz | this member's own leg | no, as expected |
| 440 Hz | this member's own additional device | **yes** |

The server excludes a member's own contribution from the composite it sends back to that
member, and does not extend that to the member's own child devices. Press **Remove extra
leg** and the 440 Hz goes; press **Add extra audio track** again and it returns.

The parentage is read off the socket rather than inferred:

```
child member from WebSocket: {"member_id":"...","call_id":"...","parent_id":"<this member>","type":"device","name":"<this member's name>"}
440 Hz (this page's additional device) IS IN the stream this member receives: peak ... dB, floor ... dB, stream ... dBFS
```

A second browser in the same room with its microphone muted is the control that says the
probe works at all: both tones are genuinely in the room, so its readout shows 440 Hz and
660 Hz present. Only the publisher's own copy is missing, and only from its own mix.

For a screen share with audio this would be harmless. It is not harmless when the additional
device carries a voice agent's synthesised speech and the parent leg is what feeds that
agent's speech recogniser: the agent hears itself, reads it as somebody interrupting, and
stops. There is no client-side way around it, because `remoteStream$` is a single pre-mixed
track with no per-member audio to filter.

Without `?maintone=1` the 440 Hz half still reproduces on its own, with the microphone muted.
What the flag adds is the control that the exclusion works at all.

Three caveats. The probe judges a tone on its band peak and on how far that peak stands
above the spectrum's median, and prints both numbers with every verdict, so a marginal call
can be argued with. The mixer carries per-member `noise_suppression` and `denoise` flags,
while a steady sine is exactly the kind of signal a noise gate exists to discard: if a tone
the second browser hears does not register anywhere, that is the thing to suspect. And if any
`getUserMedia` line appears after the dial, the SDK resolved a device by itself and the run is
no longer a clean control: reset the site's camera and microphone permissions and go again.

Reproduced on 2026-09-15, twice in one session, and the levels are the point:

| Tone | Published by | Measured at A, its publisher | Measured at B |
|---|---|---|---|
| 660 Hz | A's own leg | absent for the whole run | **-32.5 dB, continuously** |
| 440 Hz | A's own additional device | **-32.1 dB, continuously** | -32.0 dB |

A's child device arrives at A at the same level A's own tone arrives at B. The child is
mixed into its parent exactly as it is mixed into everybody else, and only the parent's own
leg is taken out. A published no microphone at all in this run, and no `getUserMedia` appears
in its log after the dial.

Timings, from `run-H-own-additional-device-in-own-mix.log`: the leg was answered in
2,575 ms, its tone was in A's own mix 804 ms later, and `removeAdditionalDevice()` resolved in
564 ms and took the tone back out 562 ms after that. A second leg 70 s later repeated it:
answered in 2,755 ms, in A's own mix 763 ms later.

One artefact to know about in that log, because it is visible and it is not the defect: 660 Hz
is reported present twice, for 500 ms each time, immediately after a child leg's audio enters
the mix (`peak -55.1 dB, floor -112.9 dB` and `-66.2 dB, floor -124.6 dB`). Both are 23 dB or
more under a real tone, and both coincide with the whole spectrum lifting about 30 dB, which is
a broadband onset transient and not a 660 Hz tone. The probe now needs a full second of
agreement rather than 500 ms, which rules it out; the shipped logs predate that change.

### 8. One missed `verto.ping` ends the call

The server sends each call a `verto.ping` on a fixed cadence (46 seconds in every run so far)
and the SDK answers with a `verto.pong`. Seen first through another application: a
signal-only reconnect whose gap happened to cover a ping. The reconnect itself succeeded, but
no `verto.ping` arrived on the new socket, and one interval later the server sent `call.left`
and `verto.bye` and the call was over. Two reconnects the same day that fell between pings
changed nothing, and those calls ran for over an hour.

Join in two browsers. The **verto.ping** row counts down to the next ping once two have
arrived. In one browser, press one of:

| Button | What it does | What it separates |
|---|---|---|
| **Drop socket as next ping lands** | Closes the socket from inside the message listener for the next `verto.ping`, which runs before the SDK's own, so the SDK answers into a closing socket | The original sequence, on demand instead of by luck of timing |
| **Drop socket just before next ping** | Closes the socket 300ms before the predicted ping, so the server sends it into the gap | Whether the server re-delivers a ping sent during a reconnect |
| **Swallow next pong** | Discards the SDK's `verto.pong` for the next ping. The socket stays open and nothing reconnects | Whether one unanswered ping ends the call by itself, reconnect or not |
| **Drop socket**, midway between pings | The existing button, as the control | That a reconnect alone is harmless |

Then wait one interval. What to look for, all read off the socket:

- `verto.ping #n id=... on WebSocket #k` for every ping, with the gap since the previous one.
- `verto.pong for verto.ping #n ... sent on WebSocket #k (OPEN)`, and the server's
  `acknowledged` for it. A pong sent on a `CLOSING` socket is logged in red: the browser
  discards it without an error, so the SDK believes it answered.
- `verto.ping #n ... was still unanswered when WebSocket #k closed`, and
  `verto.ping overdue` once a ping is more than five seconds late.
- `call.left frame` and `verto.bye frame`, verbatim. The bye's `cause` and `causeCode` are
  the server's own reason for the hang-up.

The SDK logs a failed pong as `Call might disconnect, error sending Verto pong` and then
treats that error as non-fatal, so the page expects no client-side teardown before the
server's bye.

## Flags

| Flag | Effect |
|---|---|
| `?nowarm=1` | Skip the pre-dial device warm-up, so the SDK's `getUserMedia` runs inside the call-create timeout (reproduction 4) |
| `?supportedapi=1` | Share via the public `startScreenShare()` instead of `vertoManager.addScreenMedia({ audio: true })` (reproduction 6) |
| `?maintone=1` | Dial with a 660 Hz tone in place of the microphone, so the page publishes a known tone on its own leg and opens no capture device at all (reproduction 7) |

All three are announced in the log at startup.

## Captured logs

The console captures of the runs the issue reports cite are not kept in this repository;
they are available on request. They were taken against the stock CDN bundle. Every one has had the capturing machine's public address replaced with
`PUBLIC_IP_REDACTED` and every `authorization_state` value replaced with
`[REDACTED-AUTH-STATE]`. Nothing else in any of them is edited: the remaining addresses are
SignalWire's own servers and private LAN ranges, and the SDK's truncation of its own log lines
(`...`) is the browser's, not ours:

| Log | Shows |
|---|---|
| `run-A-screenshare-audio-fatal.log` | Screen-share audio teardown, with the cancelled-picker control 46s earlier in the same file |
| `run-B-supplied-audio-fatal.log` | Supplied-audio teardown, with the main leg's successful swap on a real microphone as an in-file control |
| `run-B2-raw-mediaparams-frames.log` | The same, with every inbound `verto.mediaParams` frame logged verbatim |
| `run-C-invite-always-answered.log` | Five answered invites on one room, each ending the call |
| `run-C2-instant-meeting-always-answered.log` | The same on an ad hoc room |
| `run-E-gum-inside-call-create-timeout.log` | The call-create timeout with the prompt left open: 6.003s, then the leaked capture and `InvalidStateError` |
| `run-H-own-additional-device-in-own-mix.log` | Reproduction 7 from the publisher's side: 660 Hz absent, its own additional device's 440 Hz present at -32.1 dB, removed, added again |
| `run-H-control-second-member.log` | The same room from a second muted member, which hears both tones at -32 dB. The control that says the probe and the room are both fine |
| `run-F-signal-only-reconnect-invite-refused.log` | Share succeeds, socket dropped, signal-only reconnect, the same share refused with `-32003` 253ms after the invite, 50s timeout; a mute before and an unmute after the reconnect both resolve. The machine's public address in four ICE-candidate lines is replaced with `PUBLIC_IP_REDACTED`; nothing else is edited |

## What is in the repo

| File | What it is |
|---|---|
| `index.html` | The page: token and room boxes, join, mic, video, screen share, the buttons that add and remove the extra audio leg, the buttons that drop the socket or swallow a pong, the ping countdown, and the received-audio readout |
| `app.js` | The whole application. Every SDK call it makes is a documented public one, except `vertoManager.addScreenMedia` where no public equivalent exists |
| `instrument.js` | Observation, plus one deliberate action. Wraps `RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`, `MediaStreamTrack.stop` and `WebSocket` (inbound `verto.mediaParams`, `verto.attach` and error frames, outbound `verto.invite`, open and close) to log what the SDK does, and polls each peer connection's audio senders so a track swap is reported the moment it happens. It also probes the received stream for the tones the page publishes, and logs any member payload that names a parent, which is reproduction 7's evidence. It also pairs every inbound `verto.ping` with the outbound `verto.pong` that answers it, and logs `verto.bye` and `call.left` verbatim, plus the first few outgoing frames on each socket (method or reply id only, never params). Four functions change things rather than observe them, each called only by its button: `dropSocket()` closes the live WebSocket to force a reconnect, and reproduction 8 adds `dropSocketOnNextPing()`, `dropSocketBeforeNextPing()` and `swallowNextPong()` |
| `style.css` | Styling |
| `serve.mjs` | Dependency-free static HTTPS server |
| `make-cert.sh` | Generates the self-signed certificate |

`app.js` and `instrument.js` are kept apart so the application half stays as small as
it can be. Delete `instrument.js` and the defects still happen; the log just goes
quiet about them.

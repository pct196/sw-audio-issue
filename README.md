# SignalWire v4 defect reproductions

A minimal test page that reproduces defects in the `@signalwire/js` v4 Call Fabric client.
Plain HTML, CSS and JavaScript, no build step, no dependencies; the published SDK bundle is
loaded straight from jsDelivr.

The page loads `4.0.0-rc.3`. Reproductions 1 to 7 were filed against `4.0.0-rc.2`; change
the import at the top of `app.js` to go back to it.

| Reproduction | Issue | Status |
|---|---|---|
| 8. One missed `verto.ping` ends the call | [#16](https://github.com/signalwire/signalwire-js/issues/16) (server), [#17](https://github.com/signalwire/signalwire-js/issues/17) (SDK) | Open |
| 7. A member's own additional device is in its own mix | [#14](https://github.com/signalwire/signalwire-js/issues/14) | Open |
| 1 to 6 | #5, #7 to #12 | Closed, see [History](#history) |

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
on, then right-click, Save as. `test-plan.md` has the exact steps for every run. Console
captures are not kept in this repository; they are available on request.

## Open issues

### 8. One missed `verto.ping` ends the call

[#16](https://github.com/signalwire/signalwire-js/issues/16) (server) and
[#17](https://github.com/signalwire/signalwire-js/issues/17) (SDK).

The server sends each call a `verto.ping` about every 46 seconds and the SDK answers with a
`verto.pong`. If one ping goes unanswered, the server ends the call in the slot of the next
one: `verto.bye` with `causeCode 102, RECOVERY_ON_TIMER_EXPIRE`. A ping sent while the client
is reconnecting is never redelivered, so a sub-second reconnect that overlaps a ping is fatal.

Join in two browsers. The **verto.ping** row counts down to the next ping once two have
arrived. In one browser, press one of:

| Button | What it does | What it separates |
|---|---|---|
| **Drop socket as next ping lands** | Closes the socket from inside the message listener for the next `verto.ping`, which runs before the SDK's own, so the SDK answers into a closing socket | A pong lost on a reconnect |
| **Drop socket just before next ping** | Closes the socket 300ms before the predicted ping, so the server sends it into the gap | Whether the server redelivers a ping sent during a reconnect |
| **Swallow next pong** | Discards the SDK's `verto.pong` for the next ping. The socket stays open and nothing reconnects | Whether one unanswered ping ends the call by itself |
| **Drop socket**, midway between pings | The plain reconnect, as the control | That a reconnect alone is harmless |

Then wait two ping intervals. What to look for, all read off the socket:

- `verto.ping #n id=... on WebSocket #k` for every ping, with the gap since the previous one.
- `verto.pong for verto.ping #n ... sent on WebSocket #k (OPEN)`, and the server's
  `acknowledged` for it. A pong sent on a `CLOSING` socket is logged in red: the browser
  discards it without an error, so the SDK believes it answered.
- `verto.ping #n ... was still unanswered when WebSocket #k closed`, and
  `verto.ping overdue` once a ping is more than five seconds late.
- `WebSocket #n send #k: ...` for the first three frames on each socket (method or reply id
  only, never params). This is where #17's frames flushed ahead of `signalwire.connect` show.
- `call.left frame` and `verto.bye frame`, verbatim, with the server's `cause` and `causeCode`.

The SDK logs a failed pong as `Call might disconnect, error sending Verto pong` and raises a
non-fatal `VertoPongError`, so any teardown is the server's bye, not the client's.

| Case | Runs | Call ended |
|---|---|---|
| Pong withheld, socket open | 3 | 3 |
| Socket dropped 300ms before a ping | 3 | 3 |
| Socket dropped as a ping lands | 3 | 3 |
| Socket dropped midway (control) | 3 | 0 |

#### Resending the lost pong

Tick **Resend the lost pong once recovered** before pressing one of the three buttons. The
page then copies the SDK's last `verto.pong` frame and sends it again with fresh request ids:
after a drop, as soon as the next socket's `signalwire.connect` is answered; after a swallow,
6s later on the same socket, just after the SDK raises `VertoPongError`. A pong does not name
the ping it answers, so one copy fits any ping on the call, including one the page never
received. The log ends each attempt with `SURVIVED` (a later `verto.ping` arrived) or
`NOT RESCUED` (`verto.bye` came anyway).

All ten resends were acknowledged and every call survived: 4 of 4 dropped as a ping landed,
3 of 3 dropped just before, 3 of 3 swallowed. So a late pong counts, and so does an
unprompted one for a ping the client never saw. Resending a failed pong once the session is
authenticated again, as #17 proposes, keeps the call alive.

### 7. A member's own additional device is in the mix sent back to it

[#14](https://github.com/signalwire/signalwire-js/issues/14).

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

Measured levels:

| Tone | Published by | Measured at A, its publisher | Measured at B |
|---|---|---|---|
| 660 Hz | A's own leg | absent for the whole run | **-32.5 dB, continuously** |
| 440 Hz | A's own additional device | **-32.1 dB, continuously** | -32.0 dB |

A's child device arrives at A at the same level A's own tone arrives at B. The child is
mixed into its parent exactly as it is mixed into everybody else, and only the parent's own
leg is taken out.

Caveats. The probe judges a tone on its band peak and on how far that peak stands above the
spectrum's median, and prints both numbers with every verdict, so a marginal call can be
argued with. The mixer carries per-member `noise_suppression` and `denoise` flags, while a
steady sine is exactly the kind of signal a noise gate exists to discard: if a tone the second
browser hears does not register anywhere, that is the thing to suspect. And if any
`getUserMedia` line appears after the dial, the SDK resolved a device by itself and the run is
no longer a clean control: reset the site's camera and microphone permissions and go again.

## Flags

| Flag | Effect |
|---|---|
| `?maintone=1` | Dial with a 660 Hz tone in place of the microphone, so the page publishes a known tone on its own leg and opens no capture device at all (reproduction 7) |
| `?supportedapi=1` | Share via the public `startScreenShare()` instead of `vertoManager.addScreenMedia({ audio: true })` (reproduction 6) |
| `?nowarm=1` | Skip the pre-dial device warm-up, so the SDK's `getUserMedia` runs inside the call-create timeout (reproduction 4) |

All three are announced in the log at startup.

## History

Closed issues. The page still carries every button, so each one can be rerun.

### 1. Supplied audio is stopped, then the call is destroyed

[#7](https://github.com/signalwire/signalwire-js/issues/7),
[#8](https://github.com/signalwire/signalwire-js/issues/8).

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

[#7](https://github.com/signalwire/signalwire-js/issues/7),
[#8](https://github.com/signalwire/signalwire-js/issues/8).

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
  call survives, which is the fix for [#5](https://github.com/signalwire/signalwire-js/issues/5)
  working. Sharing with audio reaches the same classifier through a different call site and
  destroys the call.

### 3. The `verto.mediaParams` frames themselves

[#9](https://github.com/signalwire/signalwire-js/issues/9).

The page logs every inbound `verto.mediaParams` WebSocket frame verbatim
(`verto.mediaParams frame from WebSocket: {...}`), so the payload the server sends to
each leg can be read directly. Legs carrying no microphone receive microphone
processing constraints (`autoGainControl`, `echoCancellation`, `noiseSuppression`);
the `deviceId` seen in the subsequent `getUserMedia` is not in the frame, it is merged
in by the SDK from the old track.

### 4. The 6s call-create timeout contains `getUserMedia`

[#10](https://github.com/signalwire/signalwire-js/issues/10).

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

[#11](https://github.com/signalwire/signalwire-js/issues/11).

Each **Add extra audio track** press logs the time from the call to the invite being
answered (`ANSWERED in <n>ms`). Every answered invite lands between 5.6s and 5.9s. An
invite that is never served produces no error frame; the first caller-visible failure
is a `TimeoutErrorImpl` 50 seconds later, from a timeout sized for the screen-share
picker.

### 6. New legs refused after a signal-only reconnect

[#12](https://github.com/signalwire/signalwire-js/issues/12).

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
  reconnect.
- `WebSocket #n closed code=... reason=...` for every close, which the SDK itself does not
  log when it intends to reconnect.

Meanwhile share from the other browser, which did not reconnect, as the control. The share
you started and stopped before dropping the socket is the stronger control: same session,
same peer connection, and it works.

When it reproduced, the same share was refused 253ms after the invite with `-32003` "Must
provide a participant invite first", the operation failed 50 seconds later, and a
`call.unmute` on the new socket after the refusal still resolved.

## What is in the repo

| File | What it is |
|---|---|
| `index.html` | The page: token and room boxes, join, mic, video, screen share, the buttons that add and remove the extra audio leg, the buttons that drop the socket or swallow a pong, the resend checkbox, the ping countdown, and the received-audio readout |
| `app.js` | The whole application. Every SDK call it makes is a documented public one, except `vertoManager.addScreenMedia` where no public equivalent exists |
| `instrument.js` | Observation, plus a few deliberate actions. Wraps `RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`, `MediaStreamTrack.stop` and `WebSocket` to log what the SDK does: inbound `verto.mediaParams`, `verto.attach`, `verto.ping`, `verto.bye`, `call.left` and error frames, outbound `verto.invite` and `verto.pong`, the first few frames on each socket, and every open and close. It polls each peer connection's audio senders so a track swap is reported the moment it happens, probes the received stream for the tones the page publishes, and logs any member payload that names a parent. The functions that change things are called only by their buttons: `dropSocket()`, and for reproduction 8 `dropSocketOnNextPing()`, `dropSocketBeforeNextPing()` and `swallowNextPong()`, each of which can also resend the lost `verto.pong` |
| `test-plan.md` | The exact steps for every captured run |
| `test-plan.pdf` | `test-plan.md` as a printable PDF |
| `style.css` | Styling |
| `serve.mjs` | Dependency-free static HTTPS server |
| `make-cert.sh` | Generates the self-signed certificate |

`app.js` and `instrument.js` are kept apart so the application half stays as small as
it can be. Delete `instrument.js` and the defects still happen; the log just goes
quiet about them.

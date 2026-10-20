# Near — private chat, directly

Near is a lightweight browser chat room built on WebRTC. One person hosts a room and shares an invite link; guests request access and connect through the host. Text and files travel over encrypted WebRTC data channels, with the host relaying guest messages so everyone in the room shares one conversation. Voice chat uses WebRTC audio calls between participants. Messages can disappear after a chosen interval, and senders can see delivery receipts. No chat history is stored by this app.

## Requirements

- Node.js 20 or newer with Corepack and pnpm 9.15.0
- A modern browser with WebRTC support
- Microphone access is needed only when a participant joins voice chat
- Shared files must be 5 MB or smaller
- Rooms allow up to four participants, including the host
- Internet access for the default public PeerJS signaling broker and Google Fonts. For production, configure your own signaling service and TURN server.

## Run locally

```sh
cp .env.example .env
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by Vite. To try a real connection, open it in two browser windows (or on two devices on the same reachable network), create a room in one, then send its invite link to the other. The room host must keep its tab open while the room is in use.

Build a production bundle with `pnpm build`. Preview it locally with `pnpm preview`. Run the built-in checks with `pnpm test`.

## How it works

- PeerJS brokers initial peer discovery and WebRTC offer/answer exchange. In its default configuration the app uses the public PeerJS cloud broker at `0.peerjs.com`.
- The room host is the signaling peer ID in the invite URL. Guests establish reliable PeerJS data connections to that ID.
- Once established, chat payloads travel over WebRTC data channels. The host relays messages among guests; the signaling service does not carry chat text.
- WebRTC encrypts data-channel traffic in transit (DTLS). A signaling broker can still observe peer IDs and connection metadata. Treat the public broker as a development default, not a privacy guarantee.
- WebRTC can fail across restrictive NATs without TURN. Set a TURN server with short-lived credentials for reliable production use.
- Voice participants create direct WebRTC audio calls; microphone permission is requested only after tapping Voice. Voice calls use a mesh, so keep rooms small.
- File attachments travel through the host over WebRTC and are limited to 5 MB. The app does not upload them to a file server.
- Disappearing-message choices apply to messages sent after selecting the timer. Every participant removes the message when its expiry time arrives; the timer is not a substitute for preventing screenshots or copies.
- Delivery receipts show which connected participants received and rendered a message in their open room.
- Rooms accept at most four participants; extra join attempts receive a clear room-full response. Incoming text, file, and message-update events have per-peer rate limits and duplicate message IDs are ignored.
- The **Network** panel reports chat and voice state for each peer independently. It polls the browser's `RTCPeerConnection.getStats()` when available and shows selected candidate types, RTT, inbound media packet loss, and jitter only when the browser provides those values. Unavailable values stay marked unavailable. Packet loss and jitter describe received media RTP, not data-channel packets.
- The route is labelled **Direct** only when stats identify the selected candidate pair and both candidate types are available with no relay candidate. A selected relay candidate is labelled **Relayed via TURN**. If the selected pair is missing, the route is **Unknown**; no IP address, candidate address, ICE username fragment, or credential is rendered. These are local-browser observations, not a guarantee about what every participant sees.
- Recovery watches ICE failures and prolonged disconnects. It retries with a four-attempt exponential backoff (1, 2, 4, then 8 seconds), deduplicates overlapping connections, and holds a working voice call until a replacement call is ready. Guests use an in-memory resume token so the host can approve a returning connection without another prompt. The token is not persisted and is never displayed.
- PeerJS 1.5.x owns the offer/answer flow. Its exposed peer connection does not provide this app a supported renegotiation path for an ICE restart; `RTCPeerConnection.restartIce()` must be signaled through a new offer/answer exchange. Recovery therefore creates a fresh PeerJS data or media connection, which performs a new ICE negotiation through the configured PeerJS signaling service. This can briefly interrupt chat and may fail if that signaling service is unavailable.
- TURN is used only when ICE selects a relay candidate. With no TURN server configured, restrictive NATs or firewalls can prevent reconnection. The dashboard reports a relay only from the selected pair stats; STUN discovery or candidate gathering alone does not prove that the live route is direct.

## Configure signaling and ICE

Copy `.env.example` to `.env` and set a PeerJS-compatible signaling server if you run one:

```dotenv
VITE_PEER_HOST=peer.example.com
VITE_PEER_PORT=443
VITE_PEER_PATH=/peerjs
VITE_PEER_SECURE=true
VITE_ICE_SERVERS=[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"short-lived-user","credential":"short-lived-password"}]
```

The signaling server must support PeerJS server endpoints and secure WebSockets for HTTPS deployments. A TURN service such as coturn is separate from the PeerJS broker. Use credentials that expire; values prefixed with `VITE_` are embedded in the public browser bundle, so never put long-lived secrets in them. Leave `VITE_ICE_SERVERS` unset to use the browser's WebRTC defaults. A public GitHub Pages bundle cannot keep TURN credentials secret; production should issue short-lived TURN credentials from a trusted service.

The public broker is not guaranteed to be available and is not suitable as a production SLA. For a deployable setup, operate a PeerServer-compatible service and TURN server, then build with the appropriate `VITE_` settings.

## Security and privacy defaults

- Names are trimmed and limited to 32 characters; messages are trimmed and limited to 2,000 characters. Text is HTML-escaped before display.
- No accounts, cookies, analytics, or server-side chat storage are included.
- Invite URLs contain a peer ID, not a password. Anyone with the link can attempt to join while the room is open; share links privately and leave the room when finished.
- The host browser is trusted with room contents because it relays guest messages. All connected guests should be trusted.
- Peer IDs are not authentication. Add an authenticated signaling/room service and an explicit guest approval or room secret before using this design for sensitive conversations.
- HTTPS is required when deployed (localhost is allowed by browsers for development) for clipboard access and secure WebRTC behavior.

## Publish to GitHub

The app is published from the `main` branch of [`zorvael/P2P-BRO`](https://github.com/zorvael/P2P-BRO). GitHub Actions builds and deploys updates to [zorvael.github.io/P2P-BRO](https://zorvael.github.io/P2P-BRO/). To publish a change from a local clone:

```sh
git clone https://github.com/zorvael/P2P-BRO.git
cd P2P-BRO
corepack enable
pnpm install --frozen-lockfile
pnpm dev
# after editing and checking your change:
git add src README.md tests package.json .github/workflows/deploy-pages.yml
git commit -m "Describe your change"
git push origin main
```

Do not commit `.env`; it is ignored. Commit `.env.example` only, with placeholder values.

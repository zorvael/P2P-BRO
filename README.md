# Near — private chat, directly

Near is a lightweight browser chat room built on WebRTC. One person hosts a room and shares an invite link; guests request access and connect through the host. Text and files travel over encrypted WebRTC data channels, with the host relaying guest messages so everyone in the room shares one conversation. Voice chat uses WebRTC audio calls between participants. Messages can disappear after a chosen interval, and senders can see read receipts. No chat history is stored by this app.

## Requirements

- Node.js 20 or newer and npm
- A modern browser with WebRTC support
- Microphone access is needed only when a participant joins voice chat
- Shared files must be 5 MB or smaller
- Internet access for the default public PeerJS signaling broker and Google Fonts. For production, configure your own signaling service and TURN server.

## Run locally

```sh
cp .env.example .env
npm install
npm run dev
```

Open the local URL printed by Vite. To try a real connection, open it in two browser windows (or on two devices on the same reachable network), create a room in one, then send its invite link to the other. The room host must keep its tab open while the room is in use.

Build a production bundle with `npm run build`. Preview it locally with `npm run preview`. Run the built-in checks with `npm test`.

## How it works

- PeerJS brokers initial peer discovery and WebRTC offer/answer exchange. In its default configuration the app uses the public PeerJS cloud broker at `0.peerjs.com`.
- The room host is the signaling peer ID in the invite URL. Guests establish reliable PeerJS data connections to that ID.
- Once established, chat payloads travel over WebRTC data channels. The host relays messages among guests; the signaling service does not carry chat text.
- WebRTC encrypts data-channel traffic in transit (DTLS). A signaling broker can still observe peer IDs and connection metadata. Treat the public broker as a development default, not a privacy guarantee.
- WebRTC can fail across restrictive NATs without TURN. Set a TURN server with short-lived credentials for reliable production use.
- Voice participants create direct WebRTC audio calls; microphone permission is requested only after tapping Voice. Voice calls use a mesh, so keep rooms small.
- File attachments travel through the host over WebRTC and are limited to 5 MB. The app does not upload them to a file server.
- Disappearing-message choices apply to messages sent after selecting the timer. Every participant removes the message when its expiry time arrives; the timer is not a substitute for preventing screenshots or copies.
- Read receipts show which connected participants received and rendered a message in their open room.

## Configure signaling and ICE

Copy `.env.example` to `.env` and set a PeerJS-compatible signaling server if you run one:

```dotenv
VITE_PEER_HOST=peer.example.com
VITE_PEER_PORT=443
VITE_PEER_PATH=/peerjs
VITE_PEER_SECURE=true
VITE_ICE_SERVERS=[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"short-lived-user","credential":"short-lived-password"}]
```

The signaling server must support PeerJS server endpoints and secure WebSockets for HTTPS deployments. A TURN service such as coturn is separate from the PeerJS broker. Use credentials that expire; values prefixed with `VITE_` are embedded in the public browser bundle, so never put long-lived secrets in them. Leave `VITE_ICE_SERVERS` unset to use the browser's WebRTC defaults.

The public broker is not guaranteed to be available and is not suitable as a production SLA. For a deployable setup, operate a PeerServer-compatible service and TURN server, then build with the appropriate `VITE_` settings.

## Security and privacy defaults

- Names are trimmed and limited to 32 characters; messages are trimmed and limited to 2,000 characters. Text is HTML-escaped before display.
- No accounts, cookies, analytics, or server-side chat storage are included.
- Invite URLs contain a peer ID, not a password. Anyone with the link can attempt to join while the room is open; share links privately and leave the room when finished.
- The host browser is trusted with room contents because it relays guest messages. All connected guests should be trusted.
- Peer IDs are not authentication. Add an authenticated signaling/room service and an explicit guest approval or room secret before using this design for sensitive conversations.
- HTTPS is required when deployed (localhost is allowed by browsers for development) for clipboard access and secure WebRTC behavior.

## Publish to GitHub

This workspace is ready to initialize as a repository. After creating an empty GitHub repository, run:

```sh
git init
git add .
git commit -m "Build Near peer-to-peer chat app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Do not commit `.env`; it is ignored. Commit `.env.example` only, with placeholder values.

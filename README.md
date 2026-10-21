# Near — private chat, directly

Near is a lightweight browser chat room built on WebRTC. One person hosts a room and shares an invite link; guests request access and connect through the host. Text and files travel over encrypted WebRTC data channels, with the host relaying guest messages so everyone in the room shares one conversation. Voice chat uses WebRTC audio calls between participants. Messages can disappear after a chosen interval, and senders can see delivery receipts. Personal notes stay in the browser on the current device. An optional Cloudflare Worker and D1 database can provide an encrypted offline inbox and a separate account-based public Global Chat; neither works until that service is configured and deployed.

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
- **Five-minute room return:** a guest who leaves the room or refreshes the page can use the return card in the same browser tab for five minutes. The opaque resume token is held in `sessionStorage` for that tab and lets the host recognize the guest even if the browser creates a new peer ID. The host keeps the room alive when using × to step away and can return from the landing screen within five minutes; voice is stopped for privacy. Keep the host tab open. Closing the host tab/browser, losing its connection, or waiting past five minutes ends the room because the static PeerJS host is the live room coordinator; there is no always-on room server to restore it.
- PeerJS 1.5.x owns the offer/answer flow. Its exposed peer connection does not provide this app a supported renegotiation path for an ICE restart; `RTCPeerConnection.restartIce()` must be signaled through a new offer/answer exchange. Recovery therefore creates a fresh PeerJS data or media connection, which performs a new ICE negotiation through the configured PeerJS signaling service. This can briefly interrupt chat and may fail if that signaling service is unavailable.
- TURN is used only when ICE selects a relay candidate. With no TURN server configured, restrictive NATs or firewalls can prevent reconnection. The dashboard reports a relay only from the selected pair stats; STUN discovery or candidate gathering alone does not prove that the live route is direct.
- **Personal notes** are saved automatically in this browser's local storage. They do not sync to other devices and can be lost if this browser's site data is cleared.
- **Offline inbox** uses a one-time invite link. The inbox encryption key is in the URL fragment, which browsers do not send in HTTP requests. The browser encrypts message text and sender name with AES-GCM before upload; the Worker stores ciphertext, a random message ID, mailbox capability ID, and timestamps. The inbox invite is a bearer capability: anyone who has it can read the inbox and leave notes. Do not share it publicly. Notes are capped at 2,000 characters, up to 100 active notes and 20 new notes per inbox per hour, and are deleted after 30 days. The recipient must open Near to fetch notes; there are no push notifications or email alerts. Cloudflare's infrastructure may process request metadata as part of operating the service.
- **Global Chat** is one shared, hostless public message feed. Participants create a nickname/password account or sign in; it does not use OTP because no phone or email identity provider is configured. Registration checks that the user is 18+; the birth date is not saved. Language, two-letter country code, and optional gender preference are saved with the account but are not displayed in the public feed. Passwords are PBKDF2-SHA-256 hashes with random salts, and sessions are bearer tokens stored hashed in D1. Public message text is readable by other signed-in users and the service operator, is not end-to-end encrypted, and expires after seven days. Users can delete their own messages, report a message, block its author from their own feed, sign out, or delete their account and associated content. Reports are queued for 30 days, but this repository has no staffed moderation service or moderation dashboard; reporting does not promise immediate review. Do not post private or identifying information. The site is not anonymous: Cloudflare and the service operator may receive ordinary connection metadata such as IP addresses. No analytics or advertising scripts are added.

## Experiences

The **Experiences** room entry contains five additions:

- **Time capsule** currently supports a personal text note and an optional small JPG, PNG, or WebP photo (under 180 KB), saved in this browser's local storage with a countdown and opened status. This is a prototype: the browser clock controls it, local storage is inspectable, and UI hiding is not secure access control. Do not put sensitive content in a capsule. It does not create a friend/group capsule or a share link because this static architecture has no trusted timestamp, authorization backend, or secure future unlock service. Voice notes are not currently supported.
- **Shared moment** lets a participant bookmark a moment or add text to a shared timeline, remove their own contribution, and export JSON. It does not record or transcribe audio/video. Room events are relayed through the host, held only in room memory, bounded and deduplicated, and disappear when everyone leaves. The host sends a bounded snapshot to guests who reconnect.
- **Pass the moment** includes a one-line-at-a-time shared story and collaborative doodle strokes. Updates go through the existing room host, with per-event size limits and duplicate IDs. A returning participant can receive the host's current snapshot. This is not durable storage or conflict-free collaborative editing; simultaneous actions are ordered by message arrival.
- **Trust mirror** offers optional prompts and a mutual reveal after the selected room participants submit. Blank answers are treated as skipped. The host temporarily sees each answer because it relays room data, so mutual reveal is a client-level flow, not server-enforced confidentiality. There is no anonymous mode, psychological analysis, or compatibility score. Participants can leave; already submitted answers remain in the host's memory until the room ends.
- **Internet-free** is an experimental manual WebRTC data channel with no STUN/TURN servers. People must exchange offer/answer text out of band and keep the page open. It offers local text messaging only; automatic nearby discovery, Bluetooth/Wi-Fi Direct, file transfer, and reliable connectivity on every LAN are not implemented. SDP text contains temporary connection details: share it only with the intended participant. The page still has to be loaded first, and messages are not persisted.

These room experiences use a separate `experience` message type and do not change chat/call message formats. Existing guest approval still applies to joining the room. The room host can inspect and relay any room experience payload; WebRTC transport encryption does not make the host unable to read it.

### Try the experiences with people

1. Host opens the site, creates a room, and shares the invite. Each guest joins and waits for host approval. Keep the host tab open.
2. Open **Experiences → Time capsule**, save a text note or small photo for a future local date, and confirm it remains unavailable in the UI until the countdown reaches the chosen time. Use a near-future time for this prototype; the date is not secure access control.
3. Open **Shared moment** on two devices, add a bookmark and note, verify they arrive on the other device, remove one contribution from its author device, and export the timeline.
4. Open **Pass the moment** on two or more devices. Add story lines and doodle strokes from each, then briefly disconnect and reconnect a guest to see whether the host snapshot restores the room state.
5. In **Trust mirror**, the host chooses the prompt category first. Every participant checks the consent box and submits; answers should stay unrevealed until all currently connected participants submit or leave. Remember that the host can technically inspect answers in memory.
6. For **Internet-free**, load the page on two nearby devices, keep both tabs open, choose one device to create the offer, exchange the connection text privately, create and return the answer, then apply it on the first device. If it connects, send a local text message. Failure on a particular LAN/browser is expected to be possible.

The repository has automated unit/source checks, but those do not simulate multiple real browsers, mobile microphones, reconnect timing, or local-network ICE negotiation. Verify those steps with real devices before relying on the experiences.

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

## Set up the optional offline inbox

GitHub Pages is static and cannot store messages by itself. The optional Worker below is the store-and-forward service. It stores only encrypted envelopes; the AES-GCM key stays in the private invite link fragment and never goes to the Worker. The Worker limits message size and mailbox volume and purges expired rows every day.

1. Create or sign in to a Cloudflare account, install Node.js, then from this repository run:

   ```sh
   cd inbox-worker
   npx wrangler login
   npx wrangler d1 create near-offline-inbox
   ```

2. Copy the D1 `database_id` printed by Wrangler into `inbox-worker/wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

3. Apply the schema and deploy the Worker:

   ```sh
   npx wrangler d1 migrations apply near-offline-inbox --remote
   npx wrangler deploy
   ```

4. In GitHub, open **zorvael/P2P-BRO → Settings → Secrets and variables → Actions → Variables**, add `VITE_INBOX_API_URL` with the Worker base URL Wrangler printed (for example `https://near-offline-inbox.<your-subdomain>.workers.dev`). Then open **Actions → Deploy to GitHub Pages → Run workflow** so Pages builds with that URL. The same URL enables both Offline Inbox and Global Chat. The URL is public configuration, not a secret.

   For local development, put `VITE_INBOX_API_URL=https://<your-worker-url>` in the ignored `.env` file. If you use a custom site domain, add its exact origin to `ALLOWED_ORIGINS` in `inbox-worker/wrangler.toml` and redeploy the Worker.

Until the Worker is deployed and the GitHub Actions variable is set, personal notes work, while Offline Inbox and Global Chat display setup messages and cannot send messages. The Cloudflare account and database are owned and administered by the deployer; this repository cannot create them without that account's authorization. `wrangler d1 migrations apply near-offline-inbox --remote` applies both the inbox schema and the Global Chat schema. Existing deployments must run the migration and deploy the updated Worker before publishing the Pages build.

### Enable Global Chat

Global Chat shares the existing Worker deployment and D1 database. Apply migration `0002_create_global_chat.sql` with the command above and deploy the updated Worker. Keep the exact GitHub Pages origin in `ALLOWED_ORIGINS`. Build/deploy Pages with `VITE_INBOX_API_URL` set to the Worker URL. The app then displays a Global Chat entry on the landing screen. If the Worker is unavailable, the app shows an explicit setup error rather than simulating a chat.

To verify with two people, open the deployed page in two separate browser profiles/devices, accept the public-feed notice, create different accounts (both users must be 18+), and post from each device. Confirm that posts appear in both feeds, then test report, block, delete-own-message, sign-out, and account deletion. Messages are globally visible while retained; use test content only. Unit checks do not replace a real two-device Worker/D1 test.

## Security and privacy defaults

- Names are trimmed and limited to 32 characters; messages are trimmed and limited to 2,000 characters. Text is HTML-escaped before display.
- Private WebRTC rooms have no Near accounts or server-side room message store. Global Chat is a distinct public service that requires an account and stores plaintext posts for up to seven days. The optional offline inbox is separate and stores only encrypted envelopes for up to 30 days.
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

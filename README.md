# Near — private chat, directly

Near is a lightweight browser chat room built on WebRTC data channels. One person hosts a room and shares an invite link; guests connect to the host and messages travel peer to peer. The host relays guest messages so everyone in the room shares one conversation. No chat history is stored by this app.

## Requirements

- Node.js 20 or newer and npm
- A modern browser with WebRTC support
- Internet access for the default public PeerJS signaling broker and Google Fonts. For production, configure your own signaling service and TURN server.

## Run locally

```sh
cp .env.example .env
npm install
npm run dev

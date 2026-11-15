/**
 * Networking contract. Milestone 3 implements this with PeerJS (WebRTC, star topology:
 * host peer id = `sct-room-<CODE>`, clients connect to the host, host relays).
 * Kept as an interface so the transport can later be swapped (e.g. Trystero).
 */
export interface PeerInfo {
  id: string;
  nickname: string;
  carNumber: number;
  color: string;
  ready: boolean;
  isHost: boolean;
  ping: number;
}

export interface NetTransport {
  readonly isHost: boolean;
  readonly roomCode: string;
  readonly selfId: string;
  /** Unreliable/unordered: car snapshots (binary). */
  sendState(data: ArrayBuffer): void;
  /** Reliable/ordered: race events, chat, lobby. */
  sendEvent(type: string, payload: unknown, to?: string): void;
  onState(cb: (from: string, data: ArrayBuffer) => void): void;
  onEvent(cb: (from: string, type: string, payload: unknown) => void): void;
  onPeersChanged(cb: (peers: PeerInfo[]) => void): void;
  close(): void;
}

export const MAX_PLAYERS = 10;
export const peerIdForRoom = (code: string) => `sct-room-${code}`;

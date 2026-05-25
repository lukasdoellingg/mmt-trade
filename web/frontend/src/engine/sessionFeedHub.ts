/** @deprecated Use feedHubClient.ts */
export {
  subscribeFeedStream as subscribeSessionStream,
  createScriptRuntime,
  shutdownFeedHubClient as shutdownSessionFeedHub,
} from './feedHubClient';
export { USE_SESSION_MUX } from '../config/featureFlags';

export function sessionFeedHubEnabled(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

export function onSessionStatus(_handler: (status: 'live' | 'disconnected' | 'error') => void): () => void {
  return () => {};
}

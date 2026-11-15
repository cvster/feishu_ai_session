import type { NormalizedMessage } from '@larksuite/channel';
/** Only the authenticated local Web endpoint creates this message kind. */
export const WEB_INPUT_TYPE = 'bridge_web';
export const isWebInput = (message: Pick<NormalizedMessage, 'rawContentType'>): boolean => message.rawContentType === WEB_INPUT_TYPE;

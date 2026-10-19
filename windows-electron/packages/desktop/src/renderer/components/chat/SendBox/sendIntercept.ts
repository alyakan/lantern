/**
 * Lets a surrounding panel claim a typed message before it is sent to the
 * agent (the cockpit side panel uses it for "continue on <module>").
 * Return true to consume the message; the input is then cleared.
 */
import React from 'react';

export type SendInterceptor = (text: string) => boolean;

export const SendInterceptContext = React.createContext<SendInterceptor | null>(null);

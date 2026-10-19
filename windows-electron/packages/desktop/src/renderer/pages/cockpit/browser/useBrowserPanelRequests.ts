/**
 * Open the in-app browser panel when an agent's `aionui-browser` tool needs it.
 * The CDP bridge (main process) asks for it when a browser command arrives and
 * no browser page is attached yet.
 */

import { ipcBridge } from '@/common';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useEffect } from 'react';

export function useBrowserPanelRequests(): void {
  const openBrowserTab = useOptionalPreviewContext()?.openBrowserTab;
  useEffect(() => {
    if (!openBrowserTab) return;
    return ipcBridge.cockpit.browserPanelRequested.on(() => openBrowserTab());
  }, [openBrowserTab]);
}

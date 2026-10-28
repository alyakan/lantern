/**
 * Finding the Mac on the Wi-Fi by Bonjour (`_lantern._tcp`), through react-native-zeroconf. The module is native: where
 * it isn't there (Expo Go, a test) or can't scan (the local network permission was refused) nothing is found, and the
 * phone dials the addresses it was given when it paired.
 */
import type { Discovery, Found } from "./connection";

interface ResolvedService {
  port: number;
  addresses?: string[];
  ipv4?: string[];
  txt?: Record<string, string>;
}

interface ZeroconfLike {
  on(event: "resolved", cb: (s: ResolvedService) => void): unknown;
  on(event: "error", cb: (e: unknown) => void): unknown;
  scan(options: { type: string; protocol: string; domain: string }): void;
  stop(): void;
  removeDeviceListeners(): void;
}

export type ZeroconfFactory = () => ZeroconfLike | null;

const native: ZeroconfFactory = () => {
  try {
    // Required here so a build without the native module still starts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Zeroconf = require("react-native-zeroconf").default as new () => ZeroconfLike;
    return new Zeroconf();
  } catch {
    return null;
  }
};

export function zeroconfDiscovery(make: ZeroconfFactory = native): Discovery {
  return {
    find: (waitMs) =>
      new Promise<Found[]>((resolve) => {
        const zc = make();
        if (!zc) return resolve([]);
        const found: Found[] = [];
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          try {
            zc.stop();
            zc.removeDeviceListeners();
          } catch {
            // Already stopped.
          }
          resolve(found);
        };
        zc.on("resolved", (s) => {
          const host = s.ipv4?.[0] ?? s.addresses?.find((a) => a.includes(".")) ?? s.addresses?.[0];
          const id = s.txt?.id;
          if (host && id && !found.some((f) => f.host === host && f.port === s.port)) found.push({ host, port: s.port, id });
        });
        zc.on("error", () => {});
        setTimeout(finish, waitMs);
        try {
          zc.scan({ type: "lantern", protocol: "tcp", domain: "local." });
        } catch {
          finish();
        }
      }),
  };
}

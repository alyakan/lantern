import * as LocalAuthentication from "expo-local-authentication";
import { lockPlatform, resultOf, strengthOf } from "./platformLock";

describe("the real lock's reading of the phone", () => {
  it("names what the phone can check someone with", () => {
    expect(strengthOf(LocalAuthentication.SecurityLevel.NONE)).toBe("none");
    expect(strengthOf(LocalAuthentication.SecurityLevel.SECRET)).toBe("passcode");
    expect(strengthOf(LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK)).toBe("biometric");
    expect(strengthOf(LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG)).toBe("biometric");
  });

  it("tells a person backing out from a phone with nothing to check with, and from a check that didn't match", () => {
    for (const e of ["user_cancel", "system_cancel", "app_cancel"]) expect(resultOf(e)).toBe("cancelled");
    for (const e of ["not_enrolled", "passcode_not_set", "not_available"]) expect(resultOf(e)).toBe("unavailable");
    for (const e of ["authentication_failed", "lockout", "unknown", undefined]) expect(resultOf(e)).toBe("failed");
  });

  it("asks with the passcode as an alternative, so nobody is locked out", async () => {
    const authenticate = LocalAuthentication.authenticateAsync as jest.Mock;
    authenticate.mockResolvedValueOnce({ success: true });
    expect(await lockPlatform.authenticate("Unlock Lantern")).toBe("ok");
    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ promptMessage: "Unlock Lantern", disableDeviceFallback: false }));
    authenticate.mockResolvedValueOnce({ success: false, error: "user_cancel" });
    expect(await lockPlatform.authenticate("Unlock Lantern")).toBe("cancelled");
  });

  it("takes the passcode away as an alternative when it is told it must be Face ID (or a fingerprint)", async () => {
    const authenticate = LocalAuthentication.authenticateAsync as jest.Mock;
    authenticate.mockResolvedValueOnce({ success: true });
    expect(await lockPlatform.authenticate("Run a command", { biometricOnly: true })).toBe("ok");
    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ promptMessage: "Run a command", disableDeviceFallback: true }));
    // Told no, the passcode stays an alternative.
    authenticate.mockResolvedValueOnce({ success: true });
    await lockPlatform.authenticate("Unlock", { biometricOnly: false });
    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  });

  it("calls the check Face ID on an iPhone that has it", async () => {
    (LocalAuthentication.supportedAuthenticationTypesAsync as jest.Mock).mockResolvedValueOnce([LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION]);
    expect(await lockPlatform.method()).toBe("Face ID");
    (LocalAuthentication.supportedAuthenticationTypesAsync as jest.Mock).mockResolvedValueOnce([]);
    expect(await lockPlatform.method()).toBe("your passcode");
  });
});

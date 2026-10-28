import { describe, expect, it } from "vitest";
import { cloudFolderName } from "./cloudFolders";

describe("cloudFolderName", () => {
  it("recognises common sync folders on every OS", () => {
    expect(cloudFolderName("C:\\Users\\me\\OneDrive\\Documents\\Notiq Vault")).toBe("OneDrive");
    expect(cloudFolderName("C:\\Users\\me\\OneDrive - Contoso\\Docs")).toBe("OneDrive");
    expect(cloudFolderName("/Users/me/Dropbox/vault")).toBe("Dropbox");
    expect(cloudFolderName("G:\\My Drive\\notes")).toBe("Google Drive");
    expect(cloudFolderName("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x")).toBe("iCloud Drive");
    expect(cloudFolderName("D:\\pCloudDrive")).toBe("pCloud");
    expect(cloudFolderName("D:\\pCloud Drive\\x")).toBe("pCloud");
  });

  it("leaves ordinary folders alone", () => {
    expect(cloudFolderName("C:\\Users\\me\\AppData\\Roaming\\com.trexolab.notiq")).toBeNull();
    expect(cloudFolderName("/home/me/Documents/Notiq Vault")).toBeNull();
    expect(cloudFolderName("C:\\Users\\me\\boxes\\vault")).toBeNull();
  });
});

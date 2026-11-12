import { describe, it, expect } from "vitest";
import { sshMethods, sshLabel, isConnectable } from "./sshConnect";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----";

describe("sshMethods", () => {
  it("offers key and password when both are saved", () => {
    expect(sshMethods({ privateKey: KEY, password: "pw" })).toEqual(["key", "password"]);
  });
  it("offers only what exists", () => {
    expect(sshMethods({ privateKey: KEY, password: "" })).toEqual(["key"]);
    expect(sshMethods({ privateKey: "", password: "pw" })).toEqual(["password"]);
    expect(sshMethods({})).toEqual([]);
  });
  it("does not count a pasted public key as a private key", () => {
    expect(sshMethods({ privateKey: "ssh-ed25519 AAAAC3Nza user", password: "" })).toEqual([]);
  });
});

describe("sshLabel", () => {
  it("builds user@host with a non-default port", () => {
    expect(sshLabel({ host: "h.io", username: "root", port: "2222" })).toBe("root@h.io:2222");
    expect(sshLabel({ host: "h.io", port: "22" })).toBe("h.io");
    expect(sshLabel({ username: "root" })).toBe("");
  });
});

describe("isConnectable", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----";
  it("needs a host, a user name and a key or password", () => {
    expect(isConnectable({ host: "h.io", username: "root", password: "pw" })).toBe(true);
    expect(isConnectable({ host: "h.io", username: "root", privateKey: key })).toBe(true);
    expect(isConnectable({ host: "", username: "root", password: "pw" })).toBe(false);
    expect(isConnectable({ host: "h.io", username: " ", password: "pw" })).toBe(false);
    expect(isConnectable({ host: "h.io", username: "root" })).toBe(false);
    expect(isConnectable({})).toBe(false);
  });
});

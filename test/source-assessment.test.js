import test from "node:test";
import assert from "node:assert/strict";
import { assessSource, getSiteKey } from "../api/index.js";

test("recognizes a likely official Microsoft domain for Windows queries", () => {
  const result = assessSource("https://www.microsoft.com/en-us/windows", "official Windows 13 release date");
  assert.equal(result.kind, "official_candidate");
  assert.equal(result.domain, "microsoft.com");
});

test("recognizes Raspberry Pi's known official domain", () => {
  const result = assessSource("https://www.raspberrypi.com/documentation/", "Raspberry Pi 5 C SDK");
  assert.equal(result.kind, "official_candidate");
});

test("does not treat GitHub as official merely because it hosts a repository", () => {
  const result = assessSource("https://github.com/raspberrypi/pico-sdk", "Raspberry Pi 5 SDK");
  assert.equal(result.kind, "github_brand_match");
  assert.match(result.label, /официальность нужно подтвердить/);
});

test("marks unrelated GitHub ownership as unverified", () => {
  const result = assessSource("https://github.com/randomdev/board-sdk", "JieLi AC7076A SDK");
  assert.equal(result.kind, "github_unverified");
});

test("does not promote an unrelated forum to an official source", () => {
  const result = assessSource("https://forum.example.net/thread/123", "JieLi AC7076A SDK");
  assert.equal(result.kind, "independent_or_unverified");
});

test("groups subdomains under the same registrable site", () => {
  assert.equal(getSiteKey("docs.raspberrypi.com"), "raspberrypi.com");
  assert.equal(getSiteKey("support.example.co.uk"), "example.co.uk");
});

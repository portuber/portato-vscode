import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTuberBody,
  canonicalTuber,
  emptyForm,
  normalizeTags,
  prefillFrom,
  tagsToText,
  tuberChanged,
  validateFields,
  type TuberFormFields,
} from "../tuberFormFields";

function form(over: Partial<TuberFormFields> = {}): TuberFormFields {
  return { ...emptyForm(), ...over };
}

describe("normalizeTags / tagsToText", () => {
  it("splits, trims, drops empties and dedupes, keeping order", () => {
    assert.deepEqual(normalizeTags("work, eu , ,work,, home"), ["work", "eu", "home"]);
    assert.deepEqual(normalizeTags(""), []);
    assert.deepEqual(normalizeTags("   , ,"), []);
  });

  it("tagsToText joins and tolerates non-string junk", () => {
    assert.equal(tagsToText(["a", "b"]), "a, b");
    assert.equal(tagsToText(undefined), "");
    assert.equal(tagsToText("oops"), "");
    assert.equal(tagsToText(["a", 3 as unknown as string]), "a");
  });
});

describe("prefillFrom", () => {
  it("returns the add-form defaults for undefined", () => {
    const f = prefillFrom(undefined);
    assert.equal(f.type, "local");
    assert.equal(f.enabled, true);
    assert.equal(f.passwordAuth, "inherit");
    assert.equal(f.socks5Password, "");
  });

  it("maps password_auth null/true/false to the three states", () => {
    assert.equal(prefillFrom({ name: "a", password_auth: true }).passwordAuth, "on");
    assert.equal(prefillFrom({ name: "a", password_auth: false }).passwordAuth, "off");
    assert.equal(prefillFrom({ name: "a" }).passwordAuth, "inherit");
    assert.equal(prefillFrom({ name: "a", password_auth: null }).passwordAuth, "inherit");
  });

  it("never carries a secret into the form and defaults unknown types", () => {
    const f = prefillFrom({
      name: "a", type: "weird", socks5_password: "hunter2", tags: ["x", "y"],
    });
    assert.equal(f.type, "local");
    assert.equal(f.socks5Password, "");
    assert.equal(f.tags, "x, y");
  });
});

describe("validateFields", () => {
  it("requires a non-blank name and a known type", () => {
    assert.equal(validateFields(form({ name: "  " })), "Name is required");
    assert.equal(validateFields(form({ name: "a" })), null);
    assert.equal(validateFields(form({ name: "a", type: "odd" as never })), "Invalid tunnel type");
  });
});

describe("buildTuberBody", () => {
  it("writes trimmed scalars and always-wanted keys for Add", () => {
    const body = buildTuberBody(undefined, form({
      name: " web ", type: "remote", local: " :1080 ", remote: " h:80 ",
      ssh: " u@h:22 ", identity: " ~/.ssh/id ", enabled: false, tags: "a, b",
      jump: " bastion ", passwordAuth: "off", socks5User: " su ",
      socks5Password: "secret",
    }));
    assert.deepEqual(body, {
      name: "web", type: "remote", local: ":1080", remote: "h:80",
      ssh: "u@h:22", identity: "~/.ssh/id", enabled: false,
      tags: ["a", "b"], jump: "bastion", password_auth: false,
      socks5_user: "su", socks5_password: "secret",
    });
  });

  it("drops optional keys when empty (tags, jump, password_auth inherit)", () => {
    const body = buildTuberBody(undefined, form({ name: "a" }));
    assert.equal("tags" in body, false);
    assert.equal("jump" in body, false);
    assert.equal("password_auth" in body, false);
    assert.equal("socks5_password" in body, false);
  });

  it("merge keeps unknown daemon fields and untouched secrets", () => {
    const original = {
      name: "a", type: "local", local: ":1", remote: "r", ssh: "", identity: "",
      enabled: true, socks5_user: "", socks5_password: "old-secret",
      future_field: { nested: [1, 2] },
    };
    const body = buildTuberBody(original, form({ name: "a", jump: "j" }));
    assert.equal(body.future_field, original.future_field);
    assert.equal(body.socks5_password, "old-secret");
    assert.equal(body.jump, "j");
  });

  it("a typed password sets it, the flag clears it, empty keeps it", () => {
    const original = { name: "a", socks5_password: "old" };
    assert.equal(buildTuberBody(original, form({ name: "a", socks5Password: "new" })).socks5_password, "new");
    assert.equal(buildTuberBody(original, form({ name: "a", clearSocks5Password: true })).socks5_password, "");
    assert.equal(buildTuberBody(original, form({ name: "a" })).socks5_password, "old");
    // A typed password wins over the clear flag.
    assert.equal(
      buildTuberBody(original, form({ name: "a", socks5Password: "new", clearSocks5Password: true })).socks5_password,
      "new",
    );
  });
});

describe("tuberChanged / canonicalTuber", () => {
  it("is insensitive to key order and tolerant of undefined values", () => {
    const a = { name: "a", enabled: true, tags: ["x"] };
    const b = { tags: ["x"], enabled: true, name: "a" };
    assert.equal(tuberChanged(a, b), false);
    assert.equal(tuberChanged({ ...a, extra: undefined }, b), false);
  });

  it("detects real changes", () => {
    const a = { name: "a", enabled: true };
    assert.equal(tuberChanged(a, { name: "a", enabled: false }), true);
    assert.equal(tuberChanged(a, { name: "a" }), true);
    assert.equal(canonicalTuber(a), '[["enabled",true],["name","a"]]');
  });
});

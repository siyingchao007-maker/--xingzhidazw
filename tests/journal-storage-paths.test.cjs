"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createJournalStore } = require("../src/journal-storage.cjs");

const JOURNAL_KEY = "a".repeat(64);
const EPOCH = "b".repeat(32);

function createStore(directory) {
  return createJournalStore({ directory, journalKey: JOURNAL_KEY, epoch: EPOCH });
}

test("journal storage accepts a regular store reached through an ancestor junction", async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "xz-journal-junction-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const target = path.join(fixture, "target");
  const linkedParent = path.join(fixture, "linked-parent");
  fs.mkdirSync(target);
  fs.symlinkSync(target, linkedParent, process.platform === "win32" ? "junction" : "dir");

  const store = createStore(path.join(linkedParent, "journals-v1"));
  await store.initialize({ knowledgeTransactions: [], knowledgeIndexTransactions: [] });

  assert.deepEqual(await store.hydrate(), {
    knowledgeTransactions: [],
    knowledgeIndexTransactions: [],
  });
});

test("journal storage still rejects a linked directory inside the controlled store", async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "xz-journal-escape-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const root = path.join(fixture, "journals-v1");
  const store = createStore(root);
  await store.initialize({ knowledgeTransactions: [], knowledgeIndexTransactions: [] });

  const externalRecords = path.join(fixture, "external-records");
  fs.mkdirSync(externalRecords);
  fs.rmSync(path.join(root, "records"), { recursive: true, force: true });
  fs.symlinkSync(externalRecords, path.join(root, "records"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(store.hydrate(), error => error?.code === "JOURNAL_UNSAFE_PATH");
});

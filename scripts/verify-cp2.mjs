import { createClient } from "@supabase/supabase-js";

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CP2_TEST_USER_A_EMAIL",
  "CP2_TEST_USER_A_PASSWORD",
  "CP2_TEST_USER_B_EMAIL",
  "CP2_TEST_USER_B_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing test configuration: ${missing.join(", ")}`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const a = createClient(url, key, options);
const b = createClient(url, key, options);
const anonymous = createClient(url, key, options);
const cleanupAdmin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
let currentStep = "setup";
let experienceA;
let experienceB;
let objectKey;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function signIn(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert(!error && data.user, "Test account sign-in failed");
  return data.user;
}

async function cleanup() {
  let cleanupFailed = false;
  try {
    let fileRemoved = !objectKey;
    if (objectKey) {
      const result = await cleanupAdmin.storage.from("materials").remove([objectKey]);
      if (result.error) cleanupFailed = true;
      else fileRemoved = true;
    }
    // Keep the owning experience if file removal failed so its object key is
    // retained for a later cleanup retry instead of creating an orphan.
    if (experienceA && fileRemoved) {
      const result = await cleanupAdmin.from("experiences").delete().eq("id", experienceA);
      if (result.error) cleanupFailed = true;
    }
    if (experienceB) {
      const result = await cleanupAdmin.from("experiences").delete().eq("id", experienceB);
      if (result.error) cleanupFailed = true;
    }
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) console.warn("WARN: synthetic test data may require manual cleanup");
}

try {
  currentStep = "sign in two existing test accounts";
  const userA = await signIn(a, process.env.CP2_TEST_USER_A_EMAIL, process.env.CP2_TEST_USER_A_PASSWORD);
  const userB = await signIn(b, process.env.CP2_TEST_USER_B_EMAIL, process.env.CP2_TEST_USER_B_PASSWORD);
  assert(userA.id !== userB.id, "Test accounts must be different");

  currentStep = "create synthetic records for account A";
  const unique = crypto.randomUUID();
  const createdA = await a.from("experiences").insert({
    user_id: userA.id,
    name: `CP2 isolation ${unique}`,
  }).select("id").single();
  assert(!createdA.error && createdA.data, "Could not create account A experience");
  experienceA = createdA.data.id;
  const noteA = await a.from("materials").insert({
    user_id: userA.id,
    experience_id: experienceA,
    type: "note",
    text_content: "Synthetic CP2 isolation note",
    processing_status: "ready",
  }).select("id").single();
  assert(!noteA.error && noteA.data, "Could not create account A note");

  currentStep = "verify account B cannot read or modify account A records";
  const [profileRead, experienceRead, materialRead, experienceUpdate, experienceDelete, crossLink] = await Promise.all([
    b.from("profiles").select("id").eq("id", userA.id),
    b.from("experiences").select("id").eq("id", experienceA),
    b.from("materials").select("id").eq("id", noteA.data.id),
    b.from("experiences").update({ name: "Cross-user write probe" }).eq("id", experienceA).select("id"),
    b.from("experiences").delete().eq("id", experienceA).select("id"),
    b.from("materials").insert({ user_id: userB.id, experience_id: experienceA, type: "note", text_content: "Cross-owner relation probe" }),
  ]);
  assert(!profileRead.error && profileRead.data.length === 0, "Cross-user profile read was not empty");
  assert(!experienceRead.error && experienceRead.data.length === 0, "Cross-user experience read was not empty");
  assert(!materialRead.error && materialRead.data.length === 0, "Cross-user material read was not empty");
  assert(!experienceUpdate.error && experienceUpdate.data.length === 0, "Cross-user experience update affected a row");
  assert(!experienceDelete.error && experienceDelete.data.length === 0, "Cross-user experience delete affected a row");
  assert(crossLink.error, "Cross-owner experience/material relation was allowed");
  console.log("PASS: account B cannot read, update, delete, or link account A records");

  currentStep = "verify account A cannot read account B records";
  const createdB = await b.from("experiences").insert({
    user_id: userB.id,
    name: `CP2 isolation reverse ${unique}`,
  }).select("id").single();
  assert(!createdB.error && createdB.data, "Could not create account B experience");
  experienceB = createdB.data.id;
  const reverseRead = await a.from("experiences").select("id").eq("id", experienceB);
  assert(!reverseRead.error && reverseRead.data.length === 0, "Reverse cross-user experience read was not empty");
  console.log("PASS: account A cannot read account B records");

  currentStep = "verify private Storage isolation";
  const materialId = crypto.randomUUID();
  objectKey = `${userA.id}/${experienceA}/${materialId}`;
  const upload = await a.storage.from("materials").upload(objectKey, new Blob(["Synthetic CP2 file"]), {
    contentType: "text/plain",
    upsert: false,
  });
  assert(!upload.error, "Owner upload failed");
  const fileRow = await a.from("materials").insert({
    id: materialId,
    user_id: userA.id,
    experience_id: experienceA,
    type: "file",
    object_key: objectKey,
    original_filename: "cp2-isolation.txt",
    mime_type: "text/plain",
    size_bytes: 18,
    processing_status: "ready",
  }).select("id").single();
  assert(!fileRow.error && fileRow.data, "Could not register owner file");

  const [ownerDownload, crossDownload, anonymousDownload, crossUpload, crossList, crossRemove] = await Promise.all([
    a.storage.from("materials").download(objectKey),
    b.storage.from("materials").download(objectKey),
    anonymous.storage.from("materials").download(objectKey),
    b.storage.from("materials").upload(`${userA.id}/${experienceA}/${crypto.randomUUID()}`, new Blob(["probe"]), { contentType: "text/plain" }),
    b.storage.from("materials").list(`${userA.id}/${experienceA}`),
    b.storage.from("materials").remove([objectKey]),
  ]);
  assert(!ownerDownload.error && ownerDownload.data, "Owner could not download own file");
  assert(crossDownload.error, "Cross-user file download was allowed");
  assert(anonymousDownload.error, "Anonymous file download was allowed");
  assert(crossUpload.error, "Cross-user upload path was allowed");
  assert(crossList.error || crossList.data.length === 0, "Cross-user file listing was not empty");
  assert(crossRemove.error || crossRemove.data.length === 0, "Cross-user file delete affected an object");
  console.log("PASS: private Storage allows owner access and rejects cross-user/anonymous access");

  currentStep = "verify owner records remain intact";
  const ownerCheck = await a.from("experiences").select("id").eq("id", experienceA).single();
  assert(!ownerCheck.error && ownerCheck.data, "Cross-user probes changed owner data");
  console.log("PASS: owner data remains intact after rejected cross-user writes");

  currentStep = "verify direct Data API deletes cannot bypass file cleanup";
  const [directMaterialDelete, directExperienceDelete] = await Promise.all([
    a.from("materials").delete().eq("id", noteA.data.id),
    a.from("experiences").delete().eq("id", experienceA),
  ]);
  assert(directMaterialDelete.error, "Owner could directly delete a material record");
  assert(directExperienceDelete.error, "Owner could directly delete an experience record");
  console.log("PASS: direct Data API deletes are denied; server-managed cleanup cannot be bypassed");
  console.log("CP2 isolation verification completed successfully");
} catch {
  console.error(`FAIL: ${currentStep}. No credentials, record contents, or file contents were logged.`);
  process.exitCode = 1;
} finally {
  await cleanup();
  await Promise.all([a.auth.signOut({ scope: "local" }), b.auth.signOut({ scope: "local" })]);
}

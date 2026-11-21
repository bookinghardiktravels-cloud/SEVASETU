const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");
const serverTimestamp = () => new Date();

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const CUSTOMER_UID = "customer_alice_1";
const PROVIDER_UID = "provider_ramesh_2";
const OTHER_UID = "intruder_bob_3";

const [emulatorHost, emulatorPortStr] = (
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085"
).split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

function validUserPayload(uid) {
  return {
    userId: uid,
    displayName: "Aarav Patel",
    email: "aarav@example.com",
    activeRole: "customer",
    govIdType: "PAN",
    govIdMasked: "ABCDE****F",
    govIdVerified: true,
    areaName: "Navrangpura, Ahmedabad",
    latitude: 23.0365,
    longitude: 72.5611,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function validProviderPayload(uid) {
  return {
    providerId: uid,
    displayName: "Ramesh Solanki",
    category: "electrician",
    experienceYears: 7,
    rateInr: 350,
    areaName: "Satellite, Ahmedabad",
    latitude: 23.0258,
    longitude: 72.5078,
    isOnline: true,
    isListed: true,
    govIdVerified: true,
    govIdType: "VOTER_ID",
    bio: "Licensed residential and commercial electrician.",
    workPhotos: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function validBookingPayload(customerId, providerId) {
  return {
    customerId,
    customerName: "Aarav Patel",
    providerId,
    providerName: "Ramesh Solanki",
    serviceCategory: "electrician",
    serviceAddress: "14 Gulbai Tekra, Ahmedabad",
    scheduledSlot: "Today 4:00 PM - 6:00 PM",
    issueNotes: "MCB trips when AC starts",
    amountInr: 350,
    paymentMethod: "COD",
    cashCollected: false,
    status: "pending",
    reviewed: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

// --- USERS (PII & KYC Isolation) ---
test("Unauthenticated caller cannot read or write users", async () => {
  const unauth = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauth.collection("users").doc(CUSTOMER_UID).get());
  await assertFails(
    unauth.collection("users").doc(CUSTOMER_UID).set(validUserPayload(CUSTOMER_UID))
  );
});

test("User can create and read own KYC profile, cross-user read fails", async () => {
  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  await assertSucceeds(
    customerDb.collection("users").doc(CUSTOMER_UID).set(validUserPayload(CUSTOMER_UID))
  );
  await assertSucceeds(customerDb.collection("users").doc(CUSTOMER_UID).get());

  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
  await assertFails(otherDb.collection("users").doc(CUSTOMER_UID).get());
  await assertFails(otherDb.collection("users").get());
});

test("Shadow update with ghost field on user profile fails", async () => {
  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  const badPayload = { ...validUserPayload(CUSTOMER_UID), isAdmin: true };
  await assertFails(customerDb.collection("users").doc(CUSTOMER_UID).set(badPayload));
});

// --- PROVIDERS ---
test("Provider can create listing and toggle isOnline; other user cannot modify", async () => {
  const providerDb = testEnv.authenticatedContext(PROVIDER_UID).firestore();
  await assertSucceeds(
    providerDb.collection("providers").doc(PROVIDER_UID).set(validProviderPayload(PROVIDER_UID))
  );

  await assertSucceeds(
    providerDb.collection("providers").doc(PROVIDER_UID).update({
      isOnline: false,
      updatedAt: serverTimestamp(),
    })
  );

  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
  await assertFails(
    otherDb.collection("providers").doc(PROVIDER_UID).update({
      isOnline: true,
      updatedAt: serverTimestamp(),
    })
  );
});

test("Customer can list providers only with isListed == true filter", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("providers").doc(PROVIDER_UID).set(validProviderPayload(PROVIDER_UID));
  });

  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  await assertFails(customerDb.collection("providers").get());
  await assertSucceeds(
    customerDb.collection("providers").where("isListed", "==", true).get()
  );
});

// --- BOOKINGS & COD ENFORCEMENT & REVIEWS ---
test("Booking requires COD payment and valid state transitions with terminal lock", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("providers").doc(PROVIDER_UID).set(validProviderPayload(PROVIDER_UID));
  });

  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  const providerDb = testEnv.authenticatedContext(PROVIDER_UID).firestore();
  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();

  // Non-COD payment fails
  const cardBooking = { ...validBookingPayload(CUSTOMER_UID, PROVIDER_UID), paymentMethod: "CARD" };
  await assertFails(customerDb.collection("bookings").doc("b_card").set(cardBooking));

  // Self-booking fails
  await assertFails(
    providerDb.collection("bookings").doc("b_self").set(validBookingPayload(PROVIDER_UID, PROVIDER_UID))
  );

  // Valid COD booking succeeds
  await assertSucceeds(
    customerDb.collection("bookings").doc("b_1").set(validBookingPayload(CUSTOMER_UID, PROVIDER_UID))
  );

  // Third party cannot read or list
  await assertFails(otherDb.collection("bookings").doc("b_1").get());
  await assertFails(otherDb.collection("bookings").get());

  // Customer and Provider scoped list queries succeed
  await assertSucceeds(customerDb.collection("bookings").where("customerId", "==", CUSTOMER_UID).get());
  await assertSucceeds(providerDb.collection("bookings").where("providerId", "==", PROVIDER_UID).get());

  // Customer cannot mark booking accepted or completed
  await assertFails(
    customerDb.collection("bookings").doc("b_1").update({
      status: "completed",
      cashCollected: true,
      updatedAt: serverTimestamp(),
    })
  );

  // Provider accepts -> starts -> completes with COD cashCollected=true
  await assertSucceeds(
    providerDb.collection("bookings").doc("b_1").update({
      status: "accepted",
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    providerDb.collection("bookings").doc("b_1").update({
      status: "in_progress",
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    providerDb.collection("bookings").doc("b_1").update({
      status: "completed",
      cashCollected: true,
      updatedAt: serverTimestamp(),
    })
  );

  // Customer submits review + completion photo once
  await assertSucceeds(
    customerDb.collection("bookings").doc("b_1").update({
      reviewed: true,
      rating: 5,
      reviewText: "Quick MCB repair!",
      completionPhotoBase64: "abc123",
      updatedAt: serverTimestamp(),
    })
  );

  // Terminal state lock: cannot update booking after reviewed == true
  await assertFails(
    customerDb.collection("bookings").doc("b_1").update({
      rating: 1,
      updatedAt: serverTimestamp(),
    })
  );

  // Verified review creation succeeds only for completed booking owner
  await assertSucceeds(
    customerDb.collection("reviews").doc("b_1").set({
      bookingId: "b_1",
      providerId: PROVIDER_UID,
      customerId: CUSTOMER_UID,
      customerName: "Aarav Patel",
      rating: 5,
      comment: "Quick MCB repair!",
      photoBase64: "abc123",
      isPublic: true,
      createdAt: serverTimestamp(),
    })
  );

  // Intruder cannot create fake review
  await assertFails(
    otherDb.collection("reviews").doc("b_1").set({
      bookingId: "b_1",
      providerId: PROVIDER_UID,
      customerId: OTHER_UID,
      customerName: "Bob",
      rating: 1,
      comment: "Fake",
      isPublic: true,
      createdAt: serverTimestamp(),
    })
  );
});

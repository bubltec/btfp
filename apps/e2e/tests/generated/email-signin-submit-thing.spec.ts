import { test, expect } from '@playwright/test';

test('sign in with work email, submit a dangerous food item for dogs, verify confirmation', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@badthingsforpets.com`;

  // Navigate to the home page
  await page.goto('/');

  // --- Step 1: Open the email sign-in dialog and request a code ---
  await page.getByRole('button', { name: /sign in with work email/i }).click();

  await page.getByPlaceholder('you@yourclinic.org').fill(email);
  await page.getByRole('button', { name: /send code/i }).click();

  // --- Step 2: Wait for the code input to appear (confirms POST /api/auth/email/request finished) ---
  // DNS + homepage fetch + Bedrock + SES in one handler (~2.5s warm, much
  // longer if the container is still cold — deploy.yml warms first, but
  // keep headroom for a slow Bedrock/SES call).
  await expect(page.getByPlaceholder('123456')).toBeVisible({ timeout: 45000 });

  // Fetch the OTP code from the test endpoint (unauthenticated, no need for page.request here)
  const codeResponse = await page.request.get(
    `/api/auth/email/test-code?email=${encodeURIComponent(email)}`,
  );
  expect(codeResponse.ok()).toBeTruthy();
  const { code } = await codeResponse.json();

  // --- Step 3: Enter the code and sign in ---
  await page.getByPlaceholder('123456').fill(code);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Dialog should close after successful sign-in
  await expect(page.getByPlaceholder('123456')).not.toBeVisible();

  // --- Step 4: Verify the user as a contributor via the test endpoint ---
  const verifyResponse = await page.request.post('/api/auth/test/verify');
  expect(verifyResponse.ok()).toBeTruthy();

  // Reload so the app picks up the updated verifiedContributor status
  await page.reload();

  // --- Step 5: Navigate to /submit ---
  await page.goto('/submit');

  // --- Step 6: Fill out the submission form ---

  // Name
  await page.getByLabel(/^name$/i).fill('Chocolate');

  // Type — select "food" (lowercase matches real DOM value)
  await page.getByRole('combobox', { name: /type/i }).selectOption('food');

  // Dangerous for — "dog" is checked by default; confirm it's checked (or check it explicitly)
  const dogCheckbox = page.getByRole('checkbox', { name: /^dog$/i });
  if (!(await dogCheckbox.isChecked())) {
    await dogCheckbox.check();
  }

  // Why is it dangerous?
  await page
    .getByLabel(/why is it dangerous/i)
    .fill(
      'Chocolate contains theobromine and caffeine, which are toxic to dogs and can cause vomiting, seizures, and death.',
    );

  // Source (optional)
  await page
    .getByLabel(/source/i)
    .fill(
      'https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants/chocolate',
    );

  // Submit
  await page.getByRole('button', { name: /submit for review/i }).click();

  // --- Step 7: Assert on the confirmation screen ---
  await expect(page.getByRole('heading', { name: /thanks! 🐾/i })).toBeVisible();
  await expect(
    page.getByText('Your submission is in the moderation queue for review.'),
  ).toBeVisible();
});

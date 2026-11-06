import { systemPreferences } from 'electron'

/**
 * Asks the user to confirm it's them (Touch ID, or the account password from the same sheet)
 * before saved secrets — a password, a card, an address — are handed to a page. Throws if they
 * cancel. Not every Mac has Touch ID; where it isn't available this lets the fill through, relying
 * on safeStorage, which is already gated by the login Keychain.
 *
 * Tests can't touch a sensor, so under TIDEPOOL_E2E the TIDEPOOL_TEST_TOUCH_ID variable stands
 * in for the prompt: "allow" passes, anything else refuses. It's read at call time so a test can
 * flip it. Outside E2E runs the variable is ignored.
 */
export async function confirmOwner(reason: string): Promise<void> {
  if (process.env.TIDEPOOL_E2E && process.env.TIDEPOOL_TEST_TOUCH_ID !== undefined) {
    if (process.env.TIDEPOOL_TEST_TOUCH_ID !== 'allow') throw new Error('Touch ID was cancelled.')
    return
  }
  if (systemPreferences.canPromptTouchID?.()) await systemPreferences.promptTouchID(reason)
}

import { credentialFailureKey } from '../credential-service';
import type { CredentialStatus } from '../credential-service';
import type { StateDetail } from '../profiles/controller-profile';
import { redactedMessage } from '../support/homey-errors';

/**
 * Why a reconcile failed, in the form the device layer can show.
 *
 * The controller runtime and the schedule runtime had byte-identical catch
 * blocks, and each of the two decisions in them is load-bearing:
 *
 *  - **A dead key is not a broken mapping.** If a credential is present and no
 *    longer valid, the mappings are fine and only the key is not — which is a
 *    different state, a different message and a different fix (re-enter a key,
 *    keeping every mapping) from `needs_repair`. The failure CODE carries the
 *    translation; `hint` is English and only a fallback, because a sentence built
 *    in `lib/` can never be translated.
 *  - **An unclassified platform error keeps its own words, redacted.**
 *    `404 Not Found: FlowCardAction with ID <x>` is the message that costs hours
 *    (platform §3), and replacing it with "could not reach Homey" sends the next
 *    reader somewhere else entirely. Redacted because this text reaches
 *    `setUnavailable()` on the device, and an upstream error can quote the API
 *    key back inside its own message.
 */
export function classifyReconcileError(
  error: unknown,
  credential: CredentialStatus,
): { state: 'needs_credential' | 'needs_repair'; detail: StateDetail } {
  if (credential.present && !credential.valid) {
    return {
      state: 'needs_credential',
      detail: {
        key: credentialFailureKey(credential.failure),
        ...(credential.hint ? { text: credential.hint } : {}),
      },
    };
  }

  return {
    state: 'needs_repair',
    detail: { text: redactedMessage(error) },
  };
}

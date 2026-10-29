import { z } from 'zod';

const credential = '(?:credentials?|passwords?|passphrases?|(?:api[ _-]?)?keys?|(?:access|auth|api)[ _-]?tokens?)';
export const DEFAULT_CREDENTIAL_REQUEST_PATTERNS = [
  '\\b(?:send|share|give|paste|enter|provide|upload|reveal|tell|type|supply|submit|forward|show)'
    + '\\b[^.!?\\n]{0,160}\\b' + credential + '\\b',
  '\\b' + credential + '\\b[^.!?\\n]{0,80}\\b(?:please|required|needed|here)\\b',
  '\\b(?:what(?:\'s| is)|need|require)\\b[^.!?\\n]{0,80}\\b' + credential + '\\b',
];

const pattern = z.string().min(1).max(512).refine(value => {
  try {
    new RegExp(value, 'iu');
    return true;
  } catch {
    return false;
  }
}, 'invalid credential-request regular expression');

// Bounded trusted configuration, not model-provided regexes (§11.3).
export const CredentialRequestPatternsSchema = z.array(pattern).min(1).max(32)
  .default(DEFAULT_CREDENTIAL_REQUEST_PATTERNS);

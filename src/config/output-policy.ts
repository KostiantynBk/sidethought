import { z } from 'zod';

// Decision 11: bare key, token, code and PIN are intentionally not credential terms.
export const CREDENTIAL_TERM = '(?:passwords?|passcodes?|passphrases?|(?:api|secret|private|access|ssh)[ -]+keys?'
  + '|(?:api|access|auth|bearer)[ -]+tokens?|credentials?|login[ -]+details'
  + '|(?:seed|recovery)[ -]+phrases?|(?:2fa|otp|verification|one[ -]+time)[ -]+codes?|your[ -]+pin|(?<=your )pin)';
export const REQUEST_VERB = '(?:send|share|give|provide|disclose|tell|paste|enter|type|post|reveal|upload|submit'
  + '|forward|show|read[ -]+out)';
const gap = '(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}]+){0,8}[^\\p{L}\\p{N}]*';
export const DEFAULT_CREDENTIAL_REQUEST_PATTERNS = [
  `\\b${REQUEST_VERB}\\b${gap}\\b${CREDENTIAL_TERM}\\b`,
  `\\b(?:can|could|may)\\s+i\\s+(?:have|get|see|use)\\b${gap}\\b${CREDENTIAL_TERM}\\b`,
  `\\b(?:what\\s+is|what's)\\s+your\\b${gap}\\b${CREDENTIAL_TERM}\\b`,
  `\\b(?:i|we)\\s+need\\s+your\\b${gap}\\b${CREDENTIAL_TERM}\\b`,
  `\\byour\\s+${CREDENTIAL_TERM}\\b${gap}\\bplease\\b`,
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

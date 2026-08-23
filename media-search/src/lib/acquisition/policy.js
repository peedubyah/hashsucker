export const ACQUISITION_POLICY_VERSION = 1;

/**
 * Normalize the provider/account scopes an acquisition decision may consider.
 * Target order is policy preference order; no provider-specific behavior is
 * implied by a target's position.
 */
export function createAcquisitionPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Acquisition policy must be an object');
  }

  const version = input.version ?? ACQUISITION_POLICY_VERSION;
  if (version !== ACQUISITION_POLICY_VERSION) {
    throw new TypeError(`Unsupported acquisition policy version: ${version}`);
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new TypeError('Acquisition policy requires at least one provider target');
  }

  const seen = new Set();
  const targets = input.targets.map((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new TypeError(`Acquisition policy target ${index} must be an object`);
    }

    const provider = normalizeIdentifier(target.provider, `targets[${index}].provider`);
    const accountScope = normalizeIdentifier(
      target.accountScope ?? 'default',
      `targets[${index}].accountScope`,
    );
    const key = `${provider}\0${accountScope}`;
    if (seen.has(key)) {
      throw new TypeError(`Duplicate acquisition policy target: ${provider}/${accountScope}`);
    }
    seen.add(key);

    return Object.freeze({ provider, accountScope });
  });

  return Object.freeze({
    version,
    targets: Object.freeze(targets),
  });
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value.trim().toLowerCase();
}

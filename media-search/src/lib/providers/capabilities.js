export const PROVIDER_CAPABILITIES = Object.freeze({
  CACHE_OBSERVATION: 'cache-observation',
  PLACEMENT_LOOKUP: 'placement-lookup',
  PLACEMENT_CREATE: 'placement-create',
  RESOURCE_READINESS: 'resource-readiness',
  FILE_INVENTORY: 'file-inventory',
  FILE_SELECTION: 'file-selection',
  REPAIR_REQUEST: 'repair-request',
  EXPOSURE: 'exposure',
  REMOVAL: 'removal',
  // Authoritative read-only account-scope snapshot of every active placement
  // for the provider. BACKGROUND_SAFE classifiers depend on this capability
  // being present so one cheap fetch can validate multiple due placements
  // without polling per-infoHash endpoints. Read-only; never mutates.
  MYLIST_SNAPSHOT: 'mylist-snapshot',
});

const KNOWN_CAPABILITIES = new Set(Object.values(PROVIDER_CAPABILITIES));

/**
 * Create a narrow provider adapter from independently implemented capabilities.
 * Unsupported behavior is absent rather than represented by misleading booleans.
 */
export function createProviderAdapter({ provider, accountScope = 'default', capabilities = {} } = {}) {
  const normalizedProvider = normalizeIdentifier(provider, 'provider');
  const normalizedScope = normalizeIdentifier(accountScope, 'accountScope');
  const entries = Object.entries(capabilities);

  for (const [name, implementation] of entries) {
    if (!KNOWN_CAPABILITIES.has(name)) {
      throw new TypeError(`Unknown provider capability: ${name}`);
    }
    validateCapability(name, implementation);
  }

  const capabilityMap = Object.freeze(Object.fromEntries(entries));
  return Object.freeze({
    provider: normalizedProvider,
    accountScope: normalizedScope,
    capabilities: capabilityMap,
    supports(name) {
      return Object.hasOwn(capabilityMap, name);
    },
    require(name) {
      if (!this.supports(name)) {
        throw new UnsupportedProviderCapabilityError(normalizedProvider, name);
      }
      return capabilityMap[name];
    },
  });
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(provider, capability) {
    super(`${provider} does not implement provider capability ${capability}`);
    this.name = 'UnsupportedProviderCapabilityError';
    this.provider = provider;
    this.capability = capability;
    this.category = 'unsupported';
    this.retryable = false;
  }
}

function validateCapability(name, implementation) {
  if (implementation == null || typeof implementation !== 'object' || Array.isArray(implementation)) {
    throw new TypeError(`${name} capability must be an object`);
  }

  const requiredMethods = {
    [PROVIDER_CAPABILITIES.CACHE_OBSERVATION]: ['observeCache'],
    [PROVIDER_CAPABILITIES.PLACEMENT_LOOKUP]: ['lookupPlacement'],
    [PROVIDER_CAPABILITIES.PLACEMENT_CREATE]: ['createPlacement'],
    [PROVIDER_CAPABILITIES.RESOURCE_READINESS]: ['observeReadiness'],
    [PROVIDER_CAPABILITIES.FILE_INVENTORY]: ['getFileInventory'],
    [PROVIDER_CAPABILITIES.FILE_SELECTION]: ['selectKnownFiles'],
    [PROVIDER_CAPABILITIES.REPAIR_REQUEST]: ['requestRepair'],
    [PROVIDER_CAPABILITIES.EXPOSURE]: ['observeExposure'],
    [PROVIDER_CAPABILITIES.REMOVAL]: ['removeOwnedResource'],
    [PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT]: ['getMylistSnapshot'],
  }[name];

  for (const method of requiredMethods) {
    if (typeof implementation[method] !== 'function') {
      throw new TypeError(`${name} capability requires ${method}()`);
    }
  }
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError(`${field} must be a non-empty provider-safe identifier`);
  }
  return value.trim().toLowerCase();
}

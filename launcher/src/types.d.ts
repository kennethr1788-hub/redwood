export interface Doctor {
  mediaIntegration: string; providerRuntimeQualification: string;
  rows: Array<{connectorId: string; displayName: string; status: string; billingLabel: string; billingMode?: string;
    detected: boolean | null; authenticated: boolean | null;
    mode?: string | null; freshness?: string; qualificationScope?: string | null; lastCheckedAt?: string | null;
    capabilityStates: Array<{capability: string; state: string}>}>;
}

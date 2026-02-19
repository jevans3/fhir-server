# Multi-Tenant FHIR Prior Authorization SaaS Platform
## Implementation Plan — CMS-0057-F Compliant B2B Intermediary

> **Branch:** `claude/check-fhir-mongodb-gKzv2`
> **Status:** Active Development
> **Last Updated:** 2026-02-19

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Phase 1: Multi-Tenant Core Infrastructure](#phase-1-multi-tenant-core-infrastructure)
4. [Phase 2: Enhanced Auth & SMART on FHIR](#phase-2-enhanced-auth--smart-on-fhir)
5. [Phase 3: Da Vinci CRD + CDS Hooks Engine](#phase-3-da-vinci-crd--cds-hooks-engine)
6. [Phase 4: DTR SMART App + Questionnaire Engine](#phase-4-dtr-smart-app--questionnaire-engine)
7. [Phase 5: PAS Prior Authorization Operations](#phase-5-pas-prior-authorization-operations)
8. [Phase 6: CDex Clinical Data Exchange](#phase-6-cdex-clinical-data-exchange)
9. [Phase 7: Audit, Tracing & Compliance](#phase-7-audit-tracing--compliance)
10. [Phase 8: Tenant Onboarding APIs](#phase-8-tenant-onboarding-apis)
11. [Da Vinci IG Compliance Matrix](#davinci-ig-compliance-matrix)
12. [HIPAA & HITRUST Controls](#hipaa--hitrust-controls)

---

## 1. Executive Summary

This plan transforms the existing Node.js/Express/MongoDB FHIR R4 server into a **multi-tenant B2B SaaS intermediary platform** for prior authorization workflows, compliant with:

- **CMS-0057-F** (CMS Interoperability and Prior Authorization Final Rule)
- **HIPAA** Administrative, Technical, and Physical Safeguards
- **HITRUST CSF v11.5** (r2 assessment pathway)
- **Da Vinci Burden Reduction IGs 2.1+** (CRD, DTR, PAS, CDex)
- **SMART on FHIR v2.2** / OAuth 2.0 authorization

### Platform Role: B2B Intermediary (No Adjudication)

```
┌──────────────┐     ┌─────────────────────────────────┐     ┌──────────────────┐
│  PROVIDER    │     │     MT FHIR SaaS PLATFORM       │     │  PAYER /         │
│  (EHR)       │     │  ┌───────────────────────────┐  │     │  CLEARINGHOUSE   │
│              │────▶│  │ CDS Hooks (CRD)           │  │────▶│                  │
│  SMART App   │     │  │ DTR Questionnaire Engine   │  │     │  Coverage Rules   │
│  (DTR)       │◀───▶│  │ PAS $submit / $inquire    │  │◀───▶│  PA Decisions    │
│              │     │  │ CDex $submit-attachment    │  │     │  X12 278/275     │
│              │     │  │ Audit / Tracing / Logging  │  │     │                  │
│              │     │  └───────────────────────────┘  │     │                  │
└──────────────┘     └─────────────────────────────────┘     └──────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tenant Isolation | Database-per-Tenant | Strongest HIPAA isolation; clean audit boundaries |
| Auth Provider | Keycloak (extended) | Already in stack; realm-per-tenant for SMART on FHIR |
| X12 Translation | Plugin Architecture | Supports built-in + external clearinghouse adapters |
| Deployment | Cloud-Agnostic (K8s) | Matches existing Docker/K8s setup; portability |
| FHIR Version | R4 (4.0.1) | CMS-0057-F mandated; existing server version |

---

## 2. Architecture Overview

### 2.1 System Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              API GATEWAY / LB                │
                    │  (TLS termination, rate limiting, WAF)       │
                    └──────────────────┬──────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────┐
                    │         TENANT CONTEXT MIDDLEWARE            │
                    │  (Extract tenantId from JWT/header/path)     │
                    │  (Validate tenant, set correlation ID)       │
                    └──────────────────┬──────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
  ┌───────▼───────┐          ┌────────▼────────┐         ┌────────▼────────┐
  │  FHIR REST    │          │  CDS Hooks      │         │  Admin /        │
  │  Operations   │          │  Engine          │         │  Onboarding     │
  │               │          │                  │         │  APIs           │
  │  CRUD         │          │  CRD Service     │         │                 │
  │  $submit      │          │  Hook Dispatcher │         │  Tenant CRUD    │
  │  $inquire     │          │  Card Generator  │         │  Config Mgmt    │
  │  $submit-att  │          │                  │         │  Key Mgmt       │
  └───────┬───────┘          └────────┬────────┘         └────────┬────────┘
          │                            │                            │
  ┌───────▼────────────────────────────▼────────────────────────────▼───────┐
  │                     SHARED SERVICE LAYER                                │
  │                                                                         │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
  │  │ AuthZ    │ │ Audit    │ │ Tracing  │ │ X12      │ │ Notification │ │
  │  │ Manager  │ │ Logger   │ │ Manager  │ │ Adapter  │ │ Service      │ │
  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │                   TENANT-AWARE DATA LAYER                               │
  │                                                                         │
  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
  │  │ TenantDB Manager │  │ Kafka Producer   │  │ Redis Cache          │  │
  │  │ (DB-per-Tenant)  │  │ (per-tenant      │  │ (tenant-scoped keys) │  │
  │  │                  │  │  topics)          │  │                      │  │
  │  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
                                   │
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │                      MONGODB CLUSTER                                    │
  │                                                                         │
  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐  ┌──────────────┐ │
  │  │Tenant A │  │Tenant B │  │Tenant C │  │Platform│  │ Audit        │ │
  │  │  FHIR   │  │  FHIR   │  │  FHIR   │  │ Config │  │ (per-tenant) │ │
  │  │  DB     │  │  DB     │  │  DB     │  │  DB    │  │              │ │
  │  └─────────┘  └─────────┘  └─────────┘  └────────┘  └──────────────┘ │
  └─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Correlation ID & Tracing Flow

Every prior authorization request gets a **Correlation ID** that propagates end-to-end:

```
Provider EHR                    Platform                         Payer
    │                              │                                │
    │  CRD Hook Call               │                                │
    │  X-Correlation-ID: crd-xxx   │                                │
    │─────────────────────────────▶│                                │
    │                              │  Forward to Payer CRD          │
    │                              │  X-Correlation-ID: crd-xxx     │
    │                              │───────────────────────────────▶│
    │                              │◀───────────────────────────────│
    │◀─────────────────────────────│                                │
    │                              │                                │
    │  DTR $questionnaire-package  │                                │
    │  X-Correlation-ID: crd-xxx   │                                │
    │─────────────────────────────▶│  Fetch from Payer              │
    │                              │  X-Correlation-ID: crd-xxx     │
    │                              │───────────────────────────────▶│
    │◀─────────────────────────────│◀───────────────────────────────│
    │                              │                                │
    │  PAS $submit                 │                                │
    │  X-Correlation-ID: crd-xxx   │                                │
    │─────────────────────────────▶│  Submit PA (FHIR or X12 278)  │
    │                              │  X-Correlation-ID: crd-xxx     │
    │                              │───────────────────────────────▶│
    │  PA Response                 │◀───────────────────────────────│
    │◀─────────────────────────────│                                │
    │                              │                                │
    │  CDex $submit-attachment     │                                │
    │  X-Correlation-ID: crd-xxx   │                                │
    │─────────────────────────────▶│  Forward Attachment            │
    │                              │  X-Correlation-ID: crd-xxx     │
    │                              │───────────────────────────────▶│
    │◀─────────────────────────────│◀───────────────────────────────│
```

**Tracing data model:**
```javascript
{
  correlationId: "uuid-v4",          // End-to-end PA workflow ID
  requestId: "uuid-v4",              // Per-HTTP-request ID
  spanId: "hex-16",                  // OpenTelemetry span
  traceId: "hex-32",                 // OpenTelemetry trace
  tenantId: "tenant-slug",           // Tenant identifier
  tenantType: "provider|payer",      // Tenant role
  workflow: "CRD|DTR|PAS|CDex",     // Da Vinci workflow stage
  timestamp: "ISO-8601",
  userId: "practitioner-id",
  patientId: "patient-id"
}
```

---

## Phase 1: Multi-Tenant Core Infrastructure

### 1.1 Tenant Data Model

**New Collection:** `platform_config.tenants`

```javascript
{
  _id: ObjectId,
  tenantId: "acme-health",                    // URL-safe slug
  displayName: "Acme Health Systems",
  tenantType: "provider" | "payer" | "clearinghouse",
  status: "active" | "suspended" | "onboarding" | "decommissioned",

  // Organization identity
  organization: {
    npi: "1234567890",                        // NPI (Type 2)
    tin: "12-3456789",                        // Tax ID
    fhirOrganizationId: "Organization/xxx",
    addresses: [{ ... }],
    contacts: [{ name, email, phone, role }]
  },

  // Database isolation
  database: {
    name: "fhir_acme_health",                // Tenant-specific DB name
    auditDbName: "audit_acme_health",
    historyDbName: "history_acme_health",
    connectionPoolMin: 5,
    connectionPoolMax: 50,
    encryptionKeyId: "aws-kms-key-id"        // Tenant-specific encryption
  },

  // Auth configuration
  auth: {
    keycloakRealm: "acme-health",
    allowedRedirectUris: ["https://ehr.acme.com/callback"],
    smartConfiguration: {
      scopesSupported: ["system/*.cruds", "patient/*.rs", "user/*.cruds"],
      tokenEndpointAuthMethods: ["private_key_jwt"],
      jwksUri: "https://platform.example.com/tenants/acme-health/.well-known/jwks.json"
    },
    registeredClients: [{
      clientId: "acme-ehr-system",
      clientType: "backend_service",
      publicKeyFingerprint: "sha256:xxxxx",
      grantedScopes: ["system/Claim.cruds", "system/Patient.rs"],
      status: "active"
    }]
  },

  // Connected payers (for provider tenants)
  connectedPayers: [{
    payerTenantId: "blue-cross-ca",
    payerId: "payer-123",
    connectionType: "fhir_native" | "x12_clearinghouse" | "hybrid",
    endpoints: {
      crdServiceUrl: "https://crd.bluecross-ca.com/cds-services",
      dtrQuestionnaireUrl: "https://dtr.bluecross-ca.com/Questionnaire",
      pasSubmitUrl: "https://pas.bluecross-ca.com/Claim/$submit",
      cdexAttachmentUrl: "https://cdex.bluecross-ca.com/$submit-attachment"
    },
    x12Config: {
      adapterType: "built_in" | "external_clearinghouse",
      clearinghouseId: "change-healthcare",
      senderId: "ACME001",
      receiverId: "BCCA001"
    },
    credentials: {
      authMethod: "smart_backend_services",
      clientId: "platform-to-bcca",
      privateKeySecretRef: "vault://keys/bcca-private-key"
    },
    status: "active" | "pending_verification"
  }],

  // Connected providers (for payer tenants)
  connectedProviders: [{
    providerTenantId: "acme-health",
    npi: "1234567890",
    attributionListId: "attr-list-001",
    accessLevel: "full" | "restricted",
    status: "active"
  }],

  // Feature flags per tenant
  features: {
    crdEnabled: true,
    dtrEnabled: true,
    pasEnabled: true,
    cdexEnabled: true,
    bulkExportEnabled: false,
    providerAccessApiEnabled: false,
    payerToPayerEnabled: false
  },

  // Compliance metadata
  compliance: {
    baaSignedDate: "2026-01-15",
    baaDocumentRef: "s3://compliance/baas/acme-health.pdf",
    hitrustCertified: false,
    lastSecurityReview: "2026-01-01",
    dataRetentionDays: 2555                   // 7 years per CMS
  },

  createdAt: ISODate,
  updatedAt: ISODate,
  createdBy: "admin-user-id"
}
```

### 1.2 Files to Create/Modify

#### New Files

| File | Purpose |
|------|---------|
| `src/multiTenancy/tenantContext.js` | Request-scoped tenant context holder |
| `src/multiTenancy/tenantMiddleware.js` | Express middleware: extract & validate tenant |
| `src/multiTenancy/tenantDatabaseManager.js` | Tenant-aware MongoDB connection pool manager |
| `src/multiTenancy/tenantConfigManager.js` | Per-tenant configuration resolution |
| `src/multiTenancy/tenantService.js` | CRUD operations for tenant management |
| `src/multiTenancy/tenantValidator.js` | Tenant data validation |
| `src/multiTenancy/index.js` | Module exports |

#### Modified Files

| File | Changes |
|------|---------|
| `src/createContainer.js` | Register tenant services in DI container |
| `src/app.js` | Add tenant middleware early in pipeline |
| `src/utils/mongoDatabaseManager.js` | Extend for tenant-scoped DB resolution |
| `src/middleware/fhir/router.js` | Inject tenant middleware before auth |
| `src/config.js` | Add platform-level tenant config settings |

### 1.3 Tenant Context Middleware Flow

```
Request arrives
    │
    ▼
Extract tenantId from:
  1. JWT claim `tenant_id` (preferred for B2B)
  2. X-Tenant-ID header (API gateway passthrough)
  3. URL path prefix /tenants/:tenantId/4_0_0/...
    │
    ▼
Validate tenant exists & is active (cached lookup)
    │
    ▼
Resolve tenant database connection (connection pool per tenant)
    │
    ▼
Generate/propagate Correlation ID
    │
    ▼
Store in httpContext:
  - TENANT_ID
  - TENANT_TYPE
  - TENANT_CONFIG
  - CORRELATION_ID
    │
    ▼
Continue to auth middleware
```

### 1.4 Database-per-Tenant Connection Management

```javascript
// TenantDatabaseManager pattern
class TenantDatabaseManager {
  // Connection pool cache: tenantId -> MongoClient
  // Lazy initialization on first request
  // Connection health monitoring
  // Graceful connection draining on tenant decommission

  async getClientForTenant(tenantId) {
    // 1. Check cache
    // 2. Lookup tenant config from platform DB
    // 3. Create MongoClient with tenant-specific settings
    // 4. Cache and return
  }

  async getDatabaseForTenant(tenantId, dbType = 'fhir') {
    // Returns: fhir_<tenantId>, audit_<tenantId>, history_<tenantId>
  }
}
```

---

## Phase 2: Enhanced Auth & SMART on FHIR

### 2.1 Keycloak Multi-Tenant Configuration

**One Realm per Tenant** with:
- Realm-specific JWKS endpoints
- Client registration per connected system
- Backend Services flow (client_credentials + JWT assertion)
- EHR Launch flow (authorization_code + PKCE) for DTR apps

### 2.2 SMART on FHIR Discovery Endpoint

**New route:** `GET /tenants/:tenantId/4_0_0/.well-known/smart-configuration`

```json
{
  "issuer": "https://platform.example.com/tenants/acme-health",
  "authorization_endpoint": "https://platform.example.com/tenants/acme-health/auth/authorize",
  "token_endpoint": "https://platform.example.com/tenants/acme-health/auth/token",
  "jwks_uri": "https://platform.example.com/tenants/acme-health/.well-known/jwks.json",
  "registration_endpoint": "https://platform.example.com/tenants/acme-health/auth/register",
  "scopes_supported": [
    "system/Claim.cruds",
    "system/ClaimResponse.rs",
    "system/Patient.rs",
    "system/Coverage.rs",
    "system/Questionnaire.rs",
    "system/QuestionnaireResponse.cruds",
    "patient/*.rs",
    "user/*.cruds",
    "openid",
    "fhirUser",
    "launch",
    "launch/patient"
  ],
  "response_types_supported": ["code"],
  "token_endpoint_auth_methods_supported": ["private_key_jwt"],
  "token_endpoint_auth_signing_alg_values_supported": ["RS384", "ES384"],
  "capabilities": [
    "launch-ehr",
    "launch-standalone",
    "client-public",
    "client-confidential-asymmetric",
    "sso-openid-connect",
    "permission-v2",
    "context-ehr-patient",
    "context-standalone-patient"
  ],
  "code_challenge_methods_supported": ["S256"]
}
```

### 2.3 Files to Create/Modify

#### New Files

| File | Purpose |
|------|---------|
| `src/smartOnFhir/smartConfigurationEndpoint.js` | `.well-known/smart-configuration` per tenant |
| `src/smartOnFhir/backendServicesAuth.js` | JWT assertion validation for B2B |
| `src/smartOnFhir/launchContextManager.js` | EHR/standalone launch context handling |
| `src/smartOnFhir/scopeEnforcer.js` | Tenant-aware scope enforcement |
| `src/smartOnFhir/jwksManager.js` | Per-tenant JWKS key management |
| `src/smartOnFhir/clientRegistrationService.js` | Dynamic client registration |

#### Modified Files

| File | Changes |
|------|---------|
| `src/strategies/jwt.bearer.strategy.js` | Multi-tenant JWKS resolution |
| `src/strategies/authService.js` | Tenant-scoped auth validation |
| `src/operations/security/scopesValidator.js` | Tenant + SMART v2 scope syntax |
| `src/operations/security/scopesManager.js` | Tenant-aware scope extraction |
| `src/middleware/fhir/router.js` | Add SMART discovery routes |

---

## Phase 3: Da Vinci CRD + CDS Hooks Engine

### 3.1 CDS Hooks Service Endpoint

The platform acts as a **CDS Hooks client** (calling payer CRD services on behalf of providers) and optionally as a **CDS Hooks service** (for payer tenants hosting their rules).

#### CDS Hooks Discovery

**New route:** `GET /tenants/:tenantId/cds-services`

```json
{
  "services": [
    {
      "hook": "order-sign",
      "title": "Prior Authorization Requirements Check",
      "description": "Checks if prior authorization is required for the ordered service",
      "id": "pa-crd-check",
      "prefetch": {
        "patient": "Patient/{{context.patientId}}",
        "coverage": "Coverage?patient={{context.patientId}}&status=active",
        "conditions": "Condition?patient={{context.patientId}}&clinical-status=active"
      }
    },
    {
      "hook": "order-select",
      "title": "Coverage Information",
      "id": "coverage-info",
      "prefetch": {
        "patient": "Patient/{{context.patientId}}",
        "coverage": "Coverage?patient={{context.patientId}}&status=active"
      }
    },
    {
      "hook": "appointment-book",
      "title": "Appointment Coverage Check",
      "id": "appointment-coverage",
      "prefetch": {
        "patient": "Patient/{{context.patientId}}",
        "coverage": "Coverage?patient={{context.patientId}}&status=active"
      }
    }
  ]
}
```

### 3.2 CRD Request/Response Flow

```
Provider EHR (order-sign hook)
    │
    ▼
Platform CDS Hooks Endpoint
    │
    ├── 1. Validate hook request
    ├── 2. Extract tenant context
    ├── 3. Identify patient's payer from Coverage resource
    ├── 4. Route to correct payer CRD service
    ├── 5. Forward hook request (with prefetch data)
    ├── 6. Receive payer CRD response
    ├── 7. Transform response (add platform context)
    ├── 8. Create AuditEvent
    ├── 9. Log tracing data
    │
    ▼
Return CDS Cards to Provider EHR:
  - Coverage Information (system action)
  - External Reference cards (payer docs)
  - Launch DTR SMART App card
  - Instructions cards
```

### 3.3 CRD Response Card Types

```javascript
// Coverage Information System Action (required)
{
  "type": "systemAction",
  "resource": {
    "resourceType": "Coverage",
    "extension": [{
      "url": "http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information",
      "extension": [
        { "url": "covered", "valueCode": "covered" },
        { "url": "pa-needed", "valueCode": "auth-needed" },
        { "url": "doc-needed", "valueCode": "clinical" },
        { "url": "info-needed", "valueCode": "performer" }
      ]
    }]
  }
}

// Launch DTR SMART App Card
{
  "summary": "Complete prior authorization documentation",
  "indicator": "warning",
  "source": { "label": "Payer CRD Service" },
  "links": [{
    "label": "Open DTR",
    "url": "https://platform.example.com/dtr/launch",
    "type": "smart",
    "appContext": "{\"questionnaire\":\"Questionnaire/pa-home-oxygen\"}"
  }]
}
```

### 3.4 Files to Create

| File | Purpose |
|------|---------|
| `src/cdsHooks/cdsHooksRouter.js` | Express router for CDS Hooks endpoints |
| `src/cdsHooks/cdsHooksService.js` | CDS Hooks request processing |
| `src/cdsHooks/hookDispatcher.js` | Route hooks to correct payer service |
| `src/cdsHooks/hookValidator.js` | Validate incoming hook requests per spec |
| `src/cdsHooks/cardGenerator.js` | Generate CDS cards from payer responses |
| `src/cdsHooks/prefetchResolver.js` | Resolve prefetch data from tenant FHIR store |
| `src/cdsHooks/crdService.js` | CRD-specific hook processing |
| `src/cdsHooks/coverageInformationExtension.js` | Build CRD coverage info extensions |

---

## Phase 4: DTR SMART App + Questionnaire Engine

### 4.1 DTR Architecture

The platform provides:
1. **DTR Questionnaire Proxy** — Fetches questionnaire packages from payer DTR services
2. **CQL Execution Engine** — Executes CQL for auto-population (optional, can delegate to payer)
3. **QuestionnaireResponse Storage** — Stores completed responses per tenant
4. **DTR SMART App** — Lightweight web app for providers to complete DTR forms

### 4.2 DTR Operations

#### `$questionnaire-package` Operation

**Route:** `POST /tenants/:tenantId/4_0_0/Questionnaire/$questionnaire-package`

```javascript
// Input Parameters
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "coverage",
      "resource": { /* Coverage resource */ }
    },
    {
      "name": "order",
      "resource": { /* ServiceRequest/DeviceRequest/MedicationRequest */ }
    },
    {
      "name": "context",
      "valueCoding": { "code": "order-sign" }
    }
  ]
}

// Output: Bundle of Questionnaire + CQL Library + ValueSets
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    { "resource": { "resourceType": "Questionnaire", /* ... */ } },
    { "resource": { "resourceType": "Library", /* CQL */ } },
    { "resource": { "resourceType": "ValueSet", /* ... */ } }
  ]
}
```

#### `$next-question` Operation (Adaptive Forms)

**Route:** `POST /tenants/:tenantId/4_0_0/Questionnaire/$next-question`

### 4.3 DTR SMART App

A lightweight React-based SMART on FHIR app that:
- Launches from CRD card links (EHR Launch) or standalone
- Renders FHIR Questionnaires using SDC (Structured Data Capture)
- Executes CQL for auto-population against the EHR's FHIR endpoint
- Saves QuestionnaireResponse to the platform
- Hands off to PAS $submit workflow

### 4.4 Files to Create

| File | Purpose |
|------|---------|
| `src/operations/dtr/questionnairePackageOperation.js` | $questionnaire-package handler |
| `src/operations/dtr/nextQuestionOperation.js` | $next-question handler |
| `src/operations/dtr/dtrService.js` | DTR business logic |
| `src/operations/dtr/questionnaireProxy.js` | Proxy to payer questionnaire endpoints |
| `src/operations/dtr/cqlEngine.js` | CQL execution engine wrapper |
| `src/dtrApp/` | DTR SMART App (React, separate build) |
| `src/dtrApp/src/App.jsx` | Main DTR app component |
| `src/dtrApp/src/QuestionnaireRenderer.jsx` | SDC-compatible renderer |
| `src/dtrApp/src/FhirClient.js` | SMART on FHIR client wrapper |

---

## Phase 5: PAS Prior Authorization Operations

### 5.1 PAS $submit Operation

**Route:** `POST /tenants/:tenantId/4_0_0/Claim/$submit`

**SLA:** Response within 15 seconds (per PAS IG)

```
Provider EHR
    │
    ▼
$submit (PAS Request Bundle)
    │
    ├── 1. Validate PAS Request Bundle
    │       - PAS Claim profile
    │       - Required supporting resources
    │       - QuestionnaireResponse from DTR
    │
    ├── 2. Extract routing info
    │       - Payer from Coverage.payor
    │       - Service type from Claim.item
    │
    ├── 3. Store request in tenant DB
    │       - Assign platform tracking ID
    │       - Link to correlation ID
    │
    ├── 4. Route to payer
    │       ├── FHIR Native: Forward PAS Bundle to payer $submit
    │       ├── X12 Hybrid: Convert to X12 278 → send → convert response back
    │       └── Clearinghouse: Forward to external clearinghouse API
    │
    ├── 5. Process response
    │       - PAS ClaimResponse with authorization decision
    │       - Handle: approved / denied / pended
    │
    ├── 6. Store response in tenant DB
    │
    ├── 7. Create AuditEvent with full tracing
    │
    ├── 8. If pended: create Subscription for updates
    │
    └── 9. Return PAS Response Bundle
```

### 5.2 PAS $inquire Operation

**Route:** `POST /tenants/:tenantId/4_0_0/Claim/$inquire`

Checks status of previously submitted PA requests.

### 5.3 PAS Claim Update & Cancel

**Routes:**
- `PUT /tenants/:tenantId/4_0_0/Claim/:id` — Update PA request
- `DELETE /tenants/:tenantId/4_0_0/Claim/:id` — Cancel PA request

### 5.4 Subscription for Pended Items

```javascript
// PAS Subscription for pended PA updates
{
  "resourceType": "Subscription",
  "status": "requested",
  "criteria": "ClaimResponse?status=active&outcome=queued",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://ehr.provider.com/pas-notifications",
    "payload": "application/fhir+json",
    "header": ["Authorization: Bearer {{token}}"]
  }
}
```

### 5.5 X12 Translation Plugin Architecture

```javascript
// Plugin interface
class X12TranslationAdapter {
  async fhirToX12_278(pasRequestBundle) { /* returns X12 278 string */ }
  async x12_278ToFhir(x12Response) { /* returns PAS Response Bundle */ }
  async fhirToX12_275(attachmentBundle) { /* returns X12 275 string */ }
  async createProvenance(original, translated) { /* returns Provenance resource */ }
}

// Built-in adapter
class BuiltInX12Adapter extends X12TranslationAdapter { ... }

// External clearinghouse adapter
class ClearinghouseAdapter extends X12TranslationAdapter {
  constructor(clearinghouseConfig) { ... }
  // Delegates to clearinghouse API
}
```

### 5.6 Files to Create

| File | Purpose |
|------|---------|
| `src/operations/pas/pasSubmitOperation.js` | $submit operation handler |
| `src/operations/pas/pasInquireOperation.js` | $inquire operation handler |
| `src/operations/pas/pasClaimUpdateOperation.js` | Claim update handler |
| `src/operations/pas/pasClaimCancelOperation.js` | Claim cancel handler |
| `src/operations/pas/pasService.js` | PAS business logic & routing |
| `src/operations/pas/pasBundleValidator.js` | PAS Bundle profile validation |
| `src/operations/pas/pasResponseBuilder.js` | Build PAS Response Bundles |
| `src/operations/pas/pasSubscriptionManager.js` | Manage pended item subscriptions |
| `src/x12/x12TranslationAdapter.js` | Base adapter interface |
| `src/x12/builtInX12Adapter.js` | FHIR <-> X12 278/275 conversion |
| `src/x12/clearinghouseAdapter.js` | External clearinghouse integration |
| `src/x12/x12Parser.js` | X12 segment/loop parser |
| `src/x12/x12Generator.js` | X12 segment/loop generator |
| `src/x12/provenanceGenerator.js` | Provenance for translation audit |

---

## Phase 6: CDex Clinical Data Exchange

### 6.1 $submit-attachment Operation

**Route:** `POST /tenants/:tenantId/4_0_0/$submit-attachment`

```javascript
// Input Parameters
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "TrackingId", "valueString": "tracking-123" },
    { "name": "PayerId", "valueIdentifier": { "value": "payer-456" } },
    { "name": "OrganizationId", "valueIdentifier": { "system": "http://hl7.org/fhir/sid/us-npi", "value": "1234567890" } },
    {
      "name": "Attachment",
      "part": [
        { "name": "LineItem", "valueString": "1" },
        { "name": "Code", "valueCoding": { "system": "http://loinc.org", "code": "11506-3" } },
        {
          "name": "Content",
          "resource": {
            "resourceType": "DocumentReference",
            "content": [{ "attachment": { "contentType": "application/pdf", "data": "base64..." } }]
          }
        }
      ]
    },
    { "name": "Final", "valueBoolean": true }
  ]
}
```

### 6.2 Task-Based Exchange

Support payer-initiated data requests via FHIR Task:

```javascript
// CDex Task Data Request (created by payer tenant)
{
  "resourceType": "Task",
  "status": "requested",
  "intent": "order",
  "code": { "coding": [{ "system": "http://hl7.org/fhir/us/davinci-cdex/CodeSystem/cdex-temp", "code": "data-request-code" }] },
  "for": { "reference": "Patient/123" },
  "requester": { "reference": "Organization/payer-org" },
  "owner": { "reference": "Organization/provider-org" },
  "input": [{
    "type": { "coding": [{ "code": "data-query" }] },
    "valueString": "Condition?patient=Patient/123&clinical-status=active"
  }],
  "reasonCode": { "coding": [{ "code": "claim", "display": "Claim" }] }
}
```

### 6.3 Files to Create

| File | Purpose |
|------|---------|
| `src/operations/cdex/submitAttachmentOperation.js` | $submit-attachment handler |
| `src/operations/cdex/cdexService.js` | CDex business logic |
| `src/operations/cdex/taskBasedExchangeService.js` | Task-based data exchange |
| `src/operations/cdex/attachmentRouter.js` | Route attachments to correct payer |
| `src/operations/cdex/attachmentValidator.js` | Validate attachment parameters |

---

## Phase 7: Audit, Tracing & Compliance

### 7.1 Enhanced AuditEvent (CMS Compliant)

Every operation creates a FHIR AuditEvent per CMS-0057-F requirements:

```javascript
{
  "resourceType": "AuditEvent",
  "id": "uuid",
  "meta": {
    "security": [
      { "system": "https://platform.example.com/tenant", "code": "acme-health" }
    ]
  },
  "type": {
    "system": "http://dicom.nema.org/resources/ontology/DCM",
    "code": "110112",
    "display": "Query"
  },
  "subtype": [{
    "system": "http://hl7.org/fhir/restful-interaction",
    "code": "operation"
  }],
  "action": "E",
  "period": {
    "start": "2026-02-19T10:00:00Z",
    "end": "2026-02-19T10:00:02Z"
  },
  "recorded": "2026-02-19T10:00:02Z",
  "outcome": "0",

  "agent": [
    {
      "type": { "coding": [{ "code": "humanuser" }] },
      "who": { "reference": "Practitioner/dr-smith" },
      "requestor": true
    },
    {
      "type": { "coding": [{ "code": "source" }] },
      "who": { "reference": "Device/ehr-system" },
      "requestor": false
    }
  ],

  "source": {
    "site": "acme-health",
    "observer": { "reference": "Device/fhir-platform" },
    "type": [{ "code": "4", "display": "Application Server" }]
  },

  "entity": [
    {
      "what": { "reference": "Claim/pa-request-123" },
      "type": { "code": "2", "display": "System Object" },
      "role": { "code": "4", "display": "Domain Resource" },
      "detail": [
        { "type": "correlationId", "valueString": "corr-uuid-xxx" },
        { "type": "workflow", "valueString": "PAS-submit" },
        { "type": "tenantId", "valueString": "acme-health" },
        { "type": "payerId", "valueString": "blue-cross-ca" },
        { "type": "x12TransactionId", "valueString": "x12-278-xxx" }
      ]
    },
    {
      "what": { "reference": "Patient/patient-456" },
      "type": { "code": "1", "display": "Person" },
      "role": { "code": "1", "display": "Patient" }
    }
  ],

  // Extension for correlation tracking
  "extension": [{
    "url": "https://platform.example.com/fhir/StructureDefinition/correlation-tracking",
    "extension": [
      { "url": "correlationId", "valueString": "corr-uuid-xxx" },
      { "url": "traceId", "valueString": "otel-trace-hex-32" },
      { "url": "spanId", "valueString": "otel-span-hex-16" },
      { "url": "workflowStage", "valueCode": "PAS-submit" },
      { "url": "parentCorrelationId", "valueString": "crd-uuid-yyy" }
    ]
  }]
}
```

### 7.2 Correlation ID Tracing System

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRACING DATA FLOW                             │
│                                                                  │
│  Incoming Request                                                │
│      │                                                           │
│      ├── X-Correlation-ID header? → Use existing                │
│      │   (continues existing PA workflow)                        │
│      │                                                           │
│      └── No header? → Generate new UUID v4                      │
│          (new PA workflow begins)                                │
│                                                                  │
│  Per-Request Tracing Context:                                    │
│  ┌─────────────────────────────────────────────┐                │
│  │ correlationId: "pa-workflow-uuid"            │                │
│  │ requestId: "per-http-request-uuid"           │                │
│  │ traceId: "opentelemetry-trace-id"            │                │
│  │ spanId: "opentelemetry-span-id"              │                │
│  │ parentSpanId: "parent-span-id"               │                │
│  │ tenantId: "acme-health"                      │                │
│  │ workflow: "CRD → DTR → PAS → CDex"          │                │
│  │ workflowStage: "PAS-submit"                  │                │
│  │ patientId: "Patient/123"                     │                │
│  │ practitionerId: "Practitioner/456"            │                │
│  │ payerId: "blue-cross-ca"                     │                │
│  │ claimId: "Claim/pa-789"                      │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Propagation:                                                    │
│  ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐          │
│  │ HTTP   │───▶│ Kafka  │───▶│ DB     │───▶│Outbound│          │
│  │Headers │    │Headers │    │ Docs   │    │ HTTP   │          │
│  └────────┘    └────────┘    └────────┘    └────────┘          │
│                                                                  │
│  All correlated data queryable:                                  │
│  GET /AuditEvent?entity.detail.correlationId=pa-workflow-uuid   │
│  → Returns ALL audit events for entire PA workflow              │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 OpenTelemetry Integration

Extend existing OpenTelemetry setup with custom spans:

```javascript
// Custom span for PA workflow tracking
const paSpan = tracer.startSpan('pa.workflow', {
  attributes: {
    'pa.correlation_id': correlationId,
    'pa.tenant_id': tenantId,
    'pa.workflow_stage': 'PAS-submit',
    'pa.payer_id': payerId,
    'pa.patient_id': patientId
  }
});
```

### 7.4 Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/tracing/correlationIdManager.js` | Generate, propagate, resolve correlation IDs |
| `src/tracing/tracingContext.js` | Request-scoped tracing context |
| `src/tracing/workflowTracer.js` | PA workflow stage tracking |
| `src/tracing/spanFactory.js` | Create OpenTelemetry spans with PA attributes |
| `src/audit/enhancedAuditLogger.js` | CMS-compliant AuditEvent creation |
| `src/audit/auditEventBuilder.js` | Fluent builder for FHIR AuditEvent |
| `src/audit/complianceAuditService.js` | HIPAA/HITRUST audit requirements |

#### Modified Files

| File | Changes |
|------|---------|
| `src/utils/auditLogger.js` | Integrate correlation ID + tenant context |
| `src/utils/postRequestProcessor.js` | Pass tracing context to deferred tasks |
| `src/app.js` | Add correlation ID middleware |

---

## Phase 8: Tenant Onboarding APIs

### 8.1 Admin API Endpoints

**Base path:** `/admin/api/v1`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/tenants` | Create new tenant |
| GET | `/tenants` | List all tenants |
| GET | `/tenants/:tenantId` | Get tenant details |
| PUT | `/tenants/:tenantId` | Update tenant config |
| DELETE | `/tenants/:tenantId` | Decommission tenant |
| POST | `/tenants/:tenantId/activate` | Activate tenant |
| POST | `/tenants/:tenantId/suspend` | Suspend tenant |
| POST | `/tenants/:tenantId/clients` | Register SMART client |
| DELETE | `/tenants/:tenantId/clients/:clientId` | Revoke SMART client |
| POST | `/tenants/:tenantId/payer-connections` | Connect to payer |
| DELETE | `/tenants/:tenantId/payer-connections/:payerId` | Disconnect payer |
| POST | `/tenants/:tenantId/provider-connections` | Connect provider (payer tenant) |
| GET | `/tenants/:tenantId/health` | Tenant health check |
| GET | `/tenants/:tenantId/audit-report` | Generate audit report |

### 8.2 Tenant Onboarding Workflow

```
1. POST /admin/api/v1/tenants
   ├── Validate organization (NPI lookup)
   ├── Create tenant record (status: onboarding)
   ├── Provision tenant database
   ├── Create Keycloak realm
   ├── Generate initial admin credentials
   └── Return tenant config + credentials

2. POST /admin/api/v1/tenants/:id/clients
   ├── Register SMART on FHIR client
   ├── Exchange public keys
   ├── Configure scopes
   └── Return client registration details

3. POST /admin/api/v1/tenants/:id/payer-connections
   ├── Validate payer endpoints
   ├── Test connectivity (CRD discovery)
   ├── Exchange credentials
   ├── Configure X12 adapter
   └── Return connection status

4. POST /admin/api/v1/tenants/:id/activate
   ├── Verify all prerequisites
   ├── Run health checks
   ├── Set status: active
   └── Send welcome notification
```

### 8.3 Files to Create

| File | Purpose |
|------|---------|
| `src/admin/tenantAdminRouter.js` | Express router for admin APIs |
| `src/admin/tenantAdminController.js` | Admin API handlers |
| `src/admin/tenantProvisioningService.js` | Database + realm provisioning |
| `src/admin/tenantHealthCheckService.js` | Tenant health monitoring |
| `src/admin/payerConnectionService.js` | Payer connection management |
| `src/admin/clientRegistrationController.js` | SMART client registration |

---

## Da Vinci IG Compliance Matrix

| Requirement | IG | Status | Implementation |
|-------------|-----|--------|---------------|
| CDS Hooks 2.0 discovery | CRD 2.1 | Planned | `src/cdsHooks/` |
| order-sign hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| order-select hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| appointment-book hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| order-dispatch hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| encounter-start hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| encounter-discharge hook | CRD 2.1 | Planned | `hookDispatcher.js` |
| Coverage Information system action | CRD 2.1 | Planned | `cardGenerator.js` |
| $questionnaire-package | DTR 2.1 | Planned | `questionnairePackageOperation.js` |
| $next-question | DTR 2.1 | Planned | `nextQuestionOperation.js` |
| QuestionnaireResponse CRUD | DTR 2.1 | Planned | Existing FHIR CRUD |
| Claim/$submit | PAS 2.1 | Planned | `pasSubmitOperation.js` |
| Claim/$inquire | PAS 2.1 | Planned | `pasInquireOperation.js` |
| Claim Update | PAS 2.1 | Planned | `pasClaimUpdateOperation.js` |
| Claim Cancel | PAS 2.1 | Planned | `pasClaimCancelOperation.js` |
| PAS Subscription | PAS 2.1 | Planned | `pasSubscriptionManager.js` |
| $submit-attachment | CDex 2.1 | Planned | `submitAttachmentOperation.js` |
| Task-based exchange | CDex 2.1 | Planned | `taskBasedExchangeService.js` |
| FHIR ↔ X12 278 | PAS 2.1 | Planned | `src/x12/` |
| FHIR ↔ X12 275 | CDex 2.1 | Planned | `src/x12/` |
| Provenance tracking | CMS-0057-F | Planned | `provenanceGenerator.js` |

---

## HIPAA & HITRUST Controls

### Technical Safeguards Implemented

| Control | HIPAA § | HITRUST | Implementation |
|---------|---------|---------|---------------|
| Encryption at rest (AES-256) | 164.312(a)(2)(iv) | 0.9 | MongoDB encryption + tenant CMEK |
| Encryption in transit (TLS 1.2+) | 164.312(e)(1) | 0.9 | Express TLS + Helmet |
| Access control (RBAC) | 164.312(a)(1) | 0.1 | SMART scopes + tenant isolation |
| Audit controls | 164.312(b) | 0.1 | Enhanced AuditEvent + Kafka |
| Integrity controls | 164.312(c)(1) | 0.10 | Provenance + checksums |
| Person authentication | 164.312(d) | 0.1 | OAuth2 + SMART on FHIR |
| Unique user ID | 164.312(a)(2)(i) | 0.1 | JWT sub claim + tenant context |
| Auto logoff | 164.312(a)(2)(iii) | 0.1 | Token expiry + session timeout |
| Emergency access | 164.312(a)(2)(ii) | 0.12 | Break-glass procedure |
| Audit log integrity | 164.312(b) | 0.1 | Immutable audit DB + checksums |
| Data retention | CMS-0057-F | 0.7 | 7-year retention policy |
| Breach notification | 164.408 | 0.11 | Incident response workflow |
| BAA management | 164.502(e) | 0.6 | Tenant compliance metadata |
| Minimum necessary | 164.502(b) | 0.13 | Scope-based access + data filtering |

---

## Implementation Priority & Dependencies

```
Phase 1 (Multi-Tenant Core) ──────────────────────────────────┐
    │                                                          │
    ▼                                                          │
Phase 2 (SMART on FHIR Auth) ─────────────────────────┐       │
    │                                                  │       │
    ├───────────────────┬──────────────────┐           │       │
    ▼                   ▼                  ▼           │       │
Phase 3 (CRD)     Phase 5 (PAS)     Phase 6 (CDex)    │       │
    │                   │                  │           │       │
    ▼                   │                  │           │       │
Phase 4 (DTR) ─────────┘                  │           │       │
                        │                  │           │       │
                        ▼                  │           │       │
                   Phase 7 (Audit/Tracing) ◀───────────┘       │
                        │                                      │
                        ▼                                      │
                   Phase 8 (Onboarding APIs) ◀─────────────────┘
```

**Critical path:** Phase 1 → Phase 2 → Phase 5 (PAS) → Phase 7 (Audit)

This ordering ensures the core PA workflow is functional first, with CRD/DTR/CDex layered on as the workflow entry and exit points.

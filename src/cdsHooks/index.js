/**
 * CDS Hooks / CRD Engine - Module Exports
 *
 * Provides the Coverage Requirements Discovery (CRD) engine for the
 * FHIR server multi-tenant B2B prior authorization platform.
 *
 * Components:
 *   - CdsHooksRouter: Express router for CDS Hooks 2.0 discovery and invocation endpoints
 *   - CdsHooksService: Main request processing orchestrator (validation, prefetch, routing, audit)
 *   - HookDispatcher: Routes hook calls to payer CRD endpoints with timeout and retry
 *   - CardGenerator: Transforms payer CRD responses into CDS Cards and system actions
 *
 * Constants:
 *   - CDS_SERVICE_DEFINITIONS: Available CDS service definitions for CRD hooks
 *   - COVERAGE_INFO_EXTENSION_URL: Da Vinci CRD coverage-information extension URL
 *   - CRD_COVERAGE_INFO_SYSTEM: CRD coverage information coding system
 *   - CARD_INDICATORS: CDS Hooks card indicator levels (info, warning, critical)
 *   - COVERAGE_ASSERTIONS: CRD coverage assertion codes (covered, not-covered, prior-auth, etc.)
 *   - DEFAULT_PAYER_TIMEOUT_MS: Default timeout for payer CRD calls
 */
const { CdsHooksRouter, CDS_SERVICE_DEFINITIONS } = require('./cdsHooksRouter');
const { CdsHooksService } = require('./cdsHooksService');
const { HookDispatcher, DEFAULT_PAYER_TIMEOUT_MS } = require('./hookDispatcher');
const {
    CardGenerator,
    COVERAGE_INFO_EXTENSION_URL,
    CRD_COVERAGE_INFO_SYSTEM,
    CARD_INDICATORS,
    COVERAGE_ASSERTIONS
} = require('./cardGenerator');

module.exports = {
    CdsHooksRouter,
    CdsHooksService,
    HookDispatcher,
    CardGenerator,
    CDS_SERVICE_DEFINITIONS,
    COVERAGE_INFO_EXTENSION_URL,
    CRD_COVERAGE_INFO_SYSTEM,
    CARD_INDICATORS,
    COVERAGE_ASSERTIONS,
    DEFAULT_PAYER_TIMEOUT_MS
};

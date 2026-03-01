/**
 * Tracing Module Exports
 */
const {
    CorrelationIdManager,
    CORRELATION_ID_HEADER,
    WORKFLOW_STAGE_HEADER,
    WORKFLOW_STAGES
} = require('./correlationIdManager');

module.exports = {
    CorrelationIdManager,
    CORRELATION_ID_HEADER,
    WORKFLOW_STAGE_HEADER,
    WORKFLOW_STAGES
};

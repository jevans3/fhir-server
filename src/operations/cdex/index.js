/**
 * CDex (Clinical Data Exchange) module exports
 *
 * Provides operations and services for the Da Vinci CDex IG 2.1 implementation,
 * including $submit-attachment and Task-based data exchange.
 */
const { SubmitAttachmentOperation } = require('./submitAttachmentOperation');
const {
    TaskBasedExchangeService,
    TASK_STATUS_TRANSITIONS,
    CDEX_TASK_DATA_REQUEST_PROFILE,
    CDEX_TASK_CODE
} = require('./taskBasedExchangeService');

module.exports = {
    SubmitAttachmentOperation,
    TaskBasedExchangeService,
    TASK_STATUS_TRANSITIONS,
    CDEX_TASK_DATA_REQUEST_PROFILE,
    CDEX_TASK_CODE
};

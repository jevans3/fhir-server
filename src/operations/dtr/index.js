/**
 * DTR (Documentation Templates and Rules) module exports
 *
 * Provides operations and services for the Da Vinci DTR IG 2.1 implementation,
 * including $questionnaire-package and $next-question (adaptive forms) operations.
 */
const { QuestionnairePackageOperation } = require('./questionnairePackageOperation');
const { NextQuestionOperation } = require('./nextQuestionOperation');
const { DtrService } = require('./dtrService');

module.exports = {
    QuestionnairePackageOperation,
    NextQuestionOperation,
    DtrService
};

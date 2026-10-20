export interface paths {
    "/api/v1/help-topics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search the Compass user guide */
        get: operations["searchHelp"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/help-topics/{topic}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a Compass user-guide topic */
        get: operations["getHelp"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current programmatic identity */
        get: operations["getCurrentIdentity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/organizations/{orgSlug}/opportunity-rankings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List scored opportunities across accessible organization workspaces */
        get: operations["listOrganizationOpportunityRankings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/organizations/{orgSlug}/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List accessible workspaces in an organization with summary counts */
        get: operations["listOrganizationWorkspaces"];
        put?: never;
        /** Create a workspace as a human organization administrator */
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/organizations/{orgSlug}/workspaces/{workspaceSlug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve an accessible workspace by organization and workspace slug */
        get: operations["getWorkspaceBySlug"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List accessible workspaces */
        get: operations["listWorkspaces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a workspace */
        get: operations["getWorkspace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/analytics-connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List analytics connections without provider credentials */
        get: operations["listAnalyticsConnections"];
        put?: never;
        /** Create or rotate a Vercel analytics credential without returning it */
        post: operations["saveAnalyticsConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/analytics-connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Disconnect analytics and clear the stored credential */
        delete: operations["disconnectAnalyticsConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List artifacts */
        get: operations["listArtifacts"];
        put?: never;
        /** Create an artifact */
        post: operations["createArtifact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an artifact without private storage keys */
        get: operations["getArtifact"];
        put?: never;
        post?: never;
        /** Archive an artifact */
        delete: operations["archiveArtifact"];
        options?: never;
        head?: never;
        /** Update an artifact */
        patch: operations["updateArtifact"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts/{id}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Link an artifact to a decision request */
        post: operations["linkArtifactDecision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts/{id}/decisions/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink an artifact from a decision request */
        delete: operations["unlinkArtifactDecision"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts/{id}/solutions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Link an artifact to a solution */
        post: operations["linkArtifactSolution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/artifacts/{id}/solutions/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink an artifact from a solution */
        delete: operations["unlinkArtifactSolution"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/assumptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List assumptions */
        get: operations["listAssumptions"];
        put?: never;
        /** Create an assumption */
        post: operations["createAssumption"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/assumptions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an assumption */
        get: operations["getAssumption"];
        put?: never;
        post?: never;
        /** Delete an assumption */
        delete: operations["deleteAssumption"];
        options?: never;
        head?: never;
        /** Update an assumption */
        patch: operations["updateAssumption"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-factors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List eligible SELECT card-sort factors */
        get: operations["listCardSortFactors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List card-sort rounds with blind proposal counts */
        get: operations["listCardSortRounds"];
        put?: never;
        /** Create an open card-sort round */
        post: operations["createCardSortRound"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/board": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a board filtered by the caller's blind-vote visibility */
        get: operations["getCardSortBoard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/closure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Close a card-sort round */
        post: operations["closeCardSortRound"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List new-entry proposals under blind-vote visibility */
        get: operations["listCardSortNewEntries"];
        put?: never;
        /** Propose a new opportunity without creating it */
        post: operations["proposeCardSortNewEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Withdraw the caller's pending new-entry proposal */
        delete: operations["withdrawCardSortNewEntry"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}/acceptance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Atomically accept a new entry as an opportunity */
        post: operations["acceptCardSortNewEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}/rejection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reject a pending new-entry proposal */
        post: operations["rejectCardSortNewEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List only the caller's proposals */
        get: operations["listCardSortProposals"];
        put?: never;
        /** Propose moves without changing official field values */
        post: operations["proposeCardSortMoves"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/proposals/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Withdraw the caller's proposal */
        delete: operations["withdrawCardSortProposal"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/reveal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Irreversibly reveal a card-sort round */
        post: operations["revealCardSortRound"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/tally": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get tally only when reveal policy permits */
        get: operations["getCardSortTally"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/comments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a comment */
        get: operations["getComment"];
        put?: never;
        post?: never;
        /** Delete a comment and its replies */
        delete: operations["deleteComment"];
        options?: never;
        head?: never;
        /** Update a comment */
        patch: operations["updateComment"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/comments/{id}/resolution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve a comment */
        post: operations["resolveComment"];
        /** Reopen a comment */
        delete: operations["reopenComment"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/comments/{targetType}/{targetId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List comments and replies */
        get: operations["listComments"];
        put?: never;
        /** Create a comment or reply */
        post: operations["createComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/custom-field-definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List custom-field definitions in configured display order */
        get: operations["listCustomFieldDefinitions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/custom-field-values/{objectType}/{objectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List custom-field values in configured display order */
        get: operations["listCustomFieldValues"];
        put?: never;
        /** Set a custom-field value */
        post: operations["setCustomFieldValue"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/decision-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List decision requests */
        get: operations["listDecisions"];
        put?: never;
        /** Request an immutable human decision */
        post: operations["requestDecision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/decision-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a decision request */
        get: operations["getDecision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/doc-comments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a document comment */
        get: operations["getDocComment"];
        put?: never;
        post?: never;
        /** Delete a document comment and replies */
        delete: operations["deleteDocComment"];
        options?: never;
        head?: never;
        /** Update a document comment */
        patch: operations["updateDocComment"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/doc-comments/{id}/resolution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve a document comment */
        post: operations["resolveDocComment"];
        /** Reopen a document comment */
        delete: operations["reopenDocComment"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/doc-versions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a document version */
        get: operations["getDocVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/doc-versions/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Restore a document version with required concurrency and operation tokens */
        post: operations["restoreDocVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/docs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List documents */
        get: operations["listDocs"];
        put?: never;
        /** Create a document with an idempotent operation token */
        post: operations["createDoc"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/docs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a document */
        get: operations["getDoc"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a document with required optimistic concurrency and operation tokens */
        patch: operations["updateDoc"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/docs/{id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List document comments and replies */
        get: operations["listDocComments"];
        put?: never;
        /** Create a document comment or reply */
        post: operations["createDocComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/docs/{id}/image-uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prepare a private document image upload */
        post: operations["prepareDocImageUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/docs/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List document versions */
        get: operations["listDocVersions"];
        put?: never;
        /** Create a named document version with required concurrency and operation tokens */
        post: operations["createDocVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/entity-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List typed entity links */
        get: operations["listEntityLinks"];
        put?: never;
        /** Create a link of a registered link type between two entities */
        post: operations["linkEntities"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/entity-links/{linkType}/{fromId}/{toId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a link of a registered link type */
        delete: operations["unlinkEntities"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List evidence for one discovery node */
        get: operations["listEvidence"];
        put?: never;
        /** Create evidence attached to exactly one discovery node */
        post: operations["createEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/evidence/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Move evidence to exactly one discovery node */
        patch: operations["updateEvidenceTarget"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/experiments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List experiments */
        get: operations["listExperiments"];
        put?: never;
        /** Create an experiment */
        post: operations["createExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/experiments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an experiment */
        get: operations["getExperiment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update an experiment with optimistic concurrency */
        patch: operations["updateExperiment"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/experiments/{id}/conclusion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Conclude an experiment */
        post: operations["concludeExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/experiments/{id}/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List experiment results */
        get: operations["listExperimentResults"];
        put?: never;
        /** Record an experiment result */
        post: operations["createExperimentResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List feedback */
        get: operations["listFeedback"];
        put?: never;
        /** Create feedback */
        post: operations["createFeedback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback-attachment-uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prepare a direct feedback attachment upload */
        post: operations["prepareFeedbackAttachmentUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback-sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an embedded feedback source and disclose its token once */
        post: operations["createFeedbackSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback-sources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update an embedded feedback source without returning credentials */
        patch: operations["updateFeedbackSource"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get feedback */
        get: operations["getFeedback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update feedback */
        patch: operations["updateFeedback"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback/{id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Attach a completed receipt-verified direct upload */
        post: operations["completeFeedbackAttachmentUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/feedback/{id}/roadmap-promotions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Idempotently promote feedback to the roadmap */
        post: operations["promoteFeedbackToRoadmap"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/follows/{subjectType}/{subjectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Follow a resource */
        post: operations["followResource"];
        /** Unfollow a resource */
        delete: operations["unfollowResource"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/key-results/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a key result */
        get: operations["getKeyResult"];
        put?: never;
        post?: never;
        /** Delete a key result atomically */
        delete: operations["deleteKeyResult"];
        options?: never;
        head?: never;
        /** Update a key result */
        patch: operations["updateKeyResult"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/key-results/{id}/check-ins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List key-result check-ins */
        get: operations["listCheckIns"];
        put?: never;
        /** Record a key-result check-in */
        post: operations["createCheckIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/launch-checklist-items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a launch checklist item */
        patch: operations["updateLaunchChecklistItem"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/launch-checklist-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List launch checklist templates */
        get: operations["listChecklistTemplates"];
        put?: never;
        /** Create a launch checklist template */
        post: operations["createChecklistTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metric-bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List metric bindings */
        get: operations["listMetricBindings"];
        put?: never;
        /** Bind a metric */
        post: operations["createMetricBinding"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a metric binding */
        get: operations["getMetricBinding"];
        put?: never;
        post?: never;
        /** Deactivate a metric binding */
        delete: operations["deleteMetricBinding"];
        options?: never;
        head?: never;
        /** Replace a metric binding revision */
        patch: operations["updateMetricBinding"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}/metric-observations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List metric observations */
        get: operations["listMetricObservations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh metric observations idempotently */
        post: operations["refreshMetricBinding"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metric-observations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a metric observation */
        get: operations["getMetricObservation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List metric definitions */
        get: operations["listMetrics"];
        put?: never;
        /** Create a metric definition */
        post: operations["createMetric"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/metrics/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a metric definition */
        get: operations["getMetric"];
        put?: never;
        post?: never;
        /** Archive a metric definition */
        delete: operations["archiveMetric"];
        options?: never;
        head?: never;
        /** Create a metric revision */
        patch: operations["updateMetric"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the current human user's notifications */
        get: operations["listNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark owned notifications read */
        post: operations["markNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/objectives": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List objectives */
        get: operations["listObjectives"];
        put?: never;
        /** Create an objective */
        post: operations["createObjective"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/objectives/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an objective */
        get: operations["getObjective"];
        put?: never;
        post?: never;
        /** Delete a childless objective */
        delete: operations["deleteObjective"];
        options?: never;
        head?: never;
        /** Update an objective */
        patch: operations["updateObjective"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/objectives/{id}/eligible-parent-key-results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List eligible parent key results for an objective */
        get: operations["listEligibleParentKeyResults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/objectives/{id}/key-results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List objective key results */
        get: operations["listKeyResults"];
        put?: never;
        /** Create a key result */
        post: operations["createKeyResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/okr-cycles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List OKR cycles */
        get: operations["listOkrCycles"];
        put?: never;
        /** Create an OKR cycle */
        post: operations["createOkrCycle"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/okr-cycles/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an OKR cycle */
        get: operations["getOkrCycle"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List opportunities */
        get: operations["listOpportunities"];
        put?: never;
        /** Create an opportunity */
        post: operations["createOpportunity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunities/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an opportunity */
        get: operations["getOpportunity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update an opportunity */
        patch: operations["updateOpportunity"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunities/{id}/objective-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Link an opportunity to an objective */
        post: operations["linkOpportunityObjective"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunities/{id}/objective-links/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink an opportunity from an objective */
        delete: operations["unlinkOpportunityObjective"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunities/{id}/opportunity-scores": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an opportunity score */
        get: operations["getOpportunityScore"];
        put?: never;
        /** Score an opportunity */
        post: operations["scoreOpportunity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunity-batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create up to 100 opportunities (25 for agent callers) with a per-item result; resending a clientId is idempotent */
        post: operations["createOpportunitiesBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/opportunity-rankings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List scored opportunities in one workspace */
        get: operations["listWorkspaceOpportunityRankings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/pm-interviews/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read an initiating-owner PM interview */
        get: operations["getPmInterview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/release-authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request human release authorization without dispatching */
        post: operations["requestReleaseAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/release-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List release runs */
        get: operations["listReleaseRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List non-PM research studies */
        get: operations["listResearchStudies"];
        put?: never;
        /** Create a draft research study without issuing participant credentials */
        post: operations["createResearchStudy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get research study metadata without participant identities or credentials */
        get: operations["getResearchStudy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update editable research study metadata */
        patch: operations["updateResearchStudy"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/activation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Activate a study and return its participant link once */
        post: operations["activateResearchStudy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/archival": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Archive a study while retaining research */
        post: operations["archiveResearchStudy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/closure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Close a study and revoke participant links */
        post: operations["closeResearchStudy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-link-revocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke participant links without replacement */
        post: operations["revokeResearchParticipantLinks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-link-rotations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate participant links and disclose the replacement once */
        post: operations["rotateResearchParticipantLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue a participant link and disclose it once */
        post: operations["issueResearchParticipantLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List privacy-minimal research session metadata */
        get: operations["listResearchSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/sessions/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read saved transcript turns as untrusted participant material */
        get: operations["getResearchSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-studies/{id}/syntheses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List completed synthesis snapshots only */
        get: operations["listResearchSyntheses"];
        put?: never;
        /** Store a transcript-grounded synthesis */
        post: operations["createResearchSynthesis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/research-syntheses/{id}/evidence-promotions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Promote one stored grounded finding to evidence */
        post: operations["promoteResearchEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/review-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List human review requests */
        get: operations["listReviewRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/review-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a human review request */
        get: operations["getReviewRequest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/roadmap-items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List roadmap items */
        get: operations["listRoadmapItems"];
        put?: never;
        /** Create a roadmap item */
        post: operations["createRoadmapItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a roadmap item */
        get: operations["getRoadmapItem"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a roadmap item */
        patch: operations["updateRoadmapItem"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}/launch-checklist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a roadmap item's launch checklist */
        get: operations["getLaunchChecklist"];
        put?: never;
        /** Set a roadmap item's launch tier atomically */
        post: operations["setLaunchTier"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/scoring-model-assignments/{entityType}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the active scoring-model assignment */
        get: operations["getWorkspaceScoringModel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Set or clear a scoring-model assignment */
        patch: operations["updateWorkspaceScoringModel"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/scoring-models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List scoring models available to a workspace */
        get: operations["listScoringModels"];
        put?: never;
        /** Create an organization scoring model */
        post: operations["createScoringModel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/scoring-models/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a scoring model */
        get: operations["getScoringModel"];
        put?: never;
        post?: never;
        /** Archive a scoring model */
        delete: operations["archiveScoringModel"];
        options?: never;
        head?: never;
        /** Update a scoring model atomically */
        patch: operations["updateScoringModel"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solution-batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create up to 100 solutions (25 for agent callers) under existing opportunities with a per-item result; resending a clientId is idempotent */
        post: operations["createSolutionsBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solution-plan-entries/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a solution plan entry */
        get: operations["getSolutionPlanEntry"];
        put?: never;
        post?: never;
        /** Delete a proposed solution plan entry */
        delete: operations["deleteSolutionPlanEntry"];
        options?: never;
        head?: never;
        /** Update a proposed solution plan entry */
        patch: operations["updateSolutionPlanEntry"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List solutions */
        get: operations["listSolutions"];
        put?: never;
        /** Create a solution */
        post: operations["createSolution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a solution */
        get: operations["getSolution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a solution */
        patch: operations["updateSolution"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/key-result-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Link a solution to a key result */
        post: operations["linkSolutionKeyResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/key-result-links/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink a solution from a key result */
        delete: operations["unlinkSolutionKeyResult"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/plan-comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a top-level plan discussion comment */
        post: operations["createSolutionPlanComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/plan-entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List proposed solution plan entries and discussion */
        get: operations["listSolutionPlanEntries"];
        put?: never;
        /** Create a proposed solution plan */
        post: operations["createSolutionPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/roadmap-promotions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Idempotently promote a solution with inherited discovery links */
        post: operations["promoteSolutionToRoadmap"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/solutions/{id}/solution-scores": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a solution score */
        get: operations["getSolutionScore"];
        put?: never;
        /** Score a solution */
        post: operations["scoreSolution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/squads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List squads */
        get: operations["listSquads"];
        put?: never;
        /** Create a squad */
        post: operations["createSquad"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/squads/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a squad */
        get: operations["getSquad"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a squad */
        patch: operations["updateSquad"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get privacy-minimal workspace activity counts */
        get: operations["getWorkspaceSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/task-assignees": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List eligible task assignees */
        get: operations["listTaskAssignees"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List tasks */
        get: operations["listTasks"];
        put?: never;
        /** Create a task */
        post: operations["createTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a task */
        get: operations["getTask"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a task */
        patch: operations["updateTask"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/tasks/{id}/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List task links */
        get: operations["listTaskLinks"];
        put?: never;
        /** Link a task to another resource */
        post: operations["linkTaskResource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/tasks/{id}/links/{linkedType}/{relatedId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Unlink a task from another resource */
        delete: operations["unlinkTaskResource"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Problem: {
            code: string;
            detail: string;
            instance: string;
            issues?: {
                message: string;
                path: string;
            }[];
            status: number;
            title: string;
            type: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    searchHelp: {
        parameters: {
            query: {
                limit: number;
                query: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            excerpt: string;
                            path: string;
                            title: string;
                        }[];
                        nextCursor: null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getHelp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                topic: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        content: string;
                        description: string;
                        icon: string;
                        order: number;
                        section: string;
                        slug: string;
                        title: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getCurrentIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        agentId: string | null;
                        purpose: string;
                        userId: string | null;
                        workspaces: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            slug: string;
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listOrganizationOpportunityRankings: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                orgSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            normalizedScore: number;
                            /** Format: uuid */
                            opportunityId: string;
                            status: string;
                            title: string;
                            workspace: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listOrganizationWorkspaces: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                orgSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            description: string | null;
                            experiments: number;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            okrCycles: number;
                            opportunities: number;
                            roadmapItems: number;
                            slug: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                orgSlug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    name: string;
                    slug: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        organizationId: string;
                        slug: string;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getWorkspaceBySlug: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                orgSlug: string;
                workspaceSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        orgSlug: string;
                        slug: string;
                        thinkingModel: {
                            key: string;
                            labels: {
                                [key: string]: {
                                    plural: string;
                                    singular: string;
                                };
                            };
                            name: string;
                        };
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listWorkspaces: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** Format: uuid */
                            organizationId: string;
                            slug: string;
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        organizationId: string;
                        slug: string;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listAnalyticsConnections: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            enabled: boolean;
                            generation: number;
                            health: string;
                            /** Format: uuid */
                            id: string;
                            projectId: string;
                            provider: string;
                            teamId: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    saveAnalyticsConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    projectId: string;
                    /** @constant */
                    provider: "vercel";
                    teamId?: string;
                    token: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        enabled: boolean;
                        generation: number;
                        health: string;
                        /** Format: uuid */
                        id: string;
                        projectId: string;
                        provider: string;
                        teamId: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    disconnectAnalyticsConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listArtifacts: {
        parameters: {
            query: {
                cursor?: string;
                includeArchived?: unknown;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: date-time */
                            createdAt: string;
                            createdById?: string | null;
                            currentRevisionId: string | null;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            source?: string;
                            /** @enum {string} */
                            sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                            /** @enum {string} */
                            status: "ACTIVE" | "ARCHIVED";
                            title: string;
                            /** Format: date-time */
                            updatedAt: string;
                            updatedById?: string | null;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    filename?: string;
                    html: string;
                    /** @constant */
                    sourceType: "HTML_UPLOAD";
                    title: string;
                } | {
                    description?: string;
                    /** @constant */
                    sourceType: "EXTERNAL_LINK";
                    title: string;
                    /** Format: uri */
                    url: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        artifactId?: string;
                        created?: boolean;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        linkId?: string;
                        /** Format: uuid */
                        requestId?: string;
                        /** Format: uuid */
                        revisionId?: string;
                        /** Format: uuid */
                        solutionId?: string;
                        /** @enum {string} */
                        sourceType?: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                        title?: string;
                        /** Format: uuid */
                        workspaceId?: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        createdAt: string;
                        createdById?: string | null;
                        currentRevision: {
                            /** Format: uuid */
                            artifactId: string;
                            byteSize: number | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdById: string | null;
                            externalUrl: string | null;
                            filename: string | null;
                            /** Format: uuid */
                            id: string;
                            mimeType: string | null;
                            revisionNumber: number;
                            sha256: string | null;
                            source: string;
                        } | null;
                        currentRevisionId: string | null;
                        decisions: {
                            /** Format: uuid */
                            id: string;
                            state?: string;
                            title: string;
                        }[];
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        revisions: {
                            /** Format: uuid */
                            artifactId: string;
                            byteSize: number | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdById: string | null;
                            externalUrl: string | null;
                            filename: string | null;
                            /** Format: uuid */
                            id: string;
                            mimeType: string | null;
                            revisionNumber: number;
                            sha256: string | null;
                            source: string;
                        }[];
                        solutions: {
                            /** Format: uuid */
                            id: string;
                            title: string;
                        }[];
                        source?: string;
                        /** @enum {string} */
                        sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                        /** @enum {string} */
                        status: "ACTIVE" | "ARCHIVED";
                        title: string;
                        /** Format: date-time */
                        updatedAt: string;
                        updatedById?: string | null;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    archiveArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    filename?: string;
                    html?: string;
                    title?: string;
                    /** Format: uri */
                    url?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        createdAt: string;
                        createdById?: string | null;
                        currentRevision: {
                            /** Format: uuid */
                            artifactId: string;
                            byteSize: number | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdById: string | null;
                            externalUrl: string | null;
                            filename: string | null;
                            /** Format: uuid */
                            id: string;
                            mimeType: string | null;
                            revisionNumber: number;
                            sha256: string | null;
                            source: string;
                        } | null;
                        currentRevisionId: string | null;
                        decisions: {
                            /** Format: uuid */
                            id: string;
                            state?: string;
                            title: string;
                        }[];
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        revisions: {
                            /** Format: uuid */
                            artifactId: string;
                            byteSize: number | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdById: string | null;
                            externalUrl: string | null;
                            filename: string | null;
                            /** Format: uuid */
                            id: string;
                            mimeType: string | null;
                            revisionNumber: number;
                            sha256: string | null;
                            source: string;
                        }[];
                        solutions: {
                            /** Format: uuid */
                            id: string;
                            title: string;
                        }[];
                        source?: string;
                        /** @enum {string} */
                        sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                        /** @enum {string} */
                        status: "ACTIVE" | "ARCHIVED";
                        title: string;
                        /** Format: date-time */
                        updatedAt: string;
                        updatedById?: string | null;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkArtifactDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    requestId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        artifactId: string;
                        created: boolean;
                        /** Format: uuid */
                        linkId: string;
                        /** Format: uuid */
                        requestId: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkArtifactDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkArtifactSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    solutionId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        artifactId?: string;
                        created?: boolean;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        linkId?: string;
                        /** Format: uuid */
                        requestId?: string;
                        /** Format: uuid */
                        revisionId?: string;
                        /** Format: uuid */
                        solutionId?: string;
                        /** @enum {string} */
                        sourceType?: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                        title?: string;
                        /** Format: uuid */
                        workspaceId?: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkArtifactSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listAssumptions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                riskLevel?: "HIGH" | "MEDIUM" | "LOW";
                solutionId?: string;
                status?: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            riskLevel: "HIGH" | "MEDIUM" | "LOW";
                            /** Format: uuid */
                            solutionId: string;
                            /** @enum {string} */
                            status: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
                            title: string;
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createAssumption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** @enum {string} */
                    riskLevel?: "HIGH" | "MEDIUM" | "LOW";
                    /** Format: uuid */
                    solutionId: string;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        riskLevel: "HIGH" | "MEDIUM" | "LOW";
                        /** Format: uuid */
                        solutionId: string;
                        /** @enum {string} */
                        status: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
                        title: string;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getAssumption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        riskLevel: "HIGH" | "MEDIUM" | "LOW";
                        /** Format: uuid */
                        solutionId: string;
                        /** @enum {string} */
                        status: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
                        title: string;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteAssumption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateAssumption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** @enum {string} */
                    riskLevel?: "HIGH" | "MEDIUM" | "LOW";
                    /** @enum {string} */
                    status?: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        riskLevel: "HIGH" | "MEDIUM" | "LOW";
                        /** Format: uuid */
                        solutionId: string;
                        /** @enum {string} */
                        status: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED";
                        title: string;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCardSortFactors: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                            options: {
                                label: string;
                                value: string;
                            }[];
                            sharedOptionSetName: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCardSortRounds: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                state?: "OPEN" | "REVEALED" | "CLOSED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            closedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdById: string;
                            factorName: string;
                            /** Format: uuid */
                            fieldDefinitionId: string;
                            /** Format: uuid */
                            id: string;
                            myProposalCount: number;
                            name: string;
                            /** @enum {string} */
                            objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                            proposalCount: number | null;
                            revealedAt: string | null;
                            /** @enum {string} */
                            state: "OPEN" | "REVEALED" | "CLOSED";
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createCardSortRound: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    fieldDefinitionId: string;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        closedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        createdById: string;
                        factorName: string;
                        /** Format: uuid */
                        fieldDefinitionId: string;
                        /** Format: uuid */
                        id: string;
                        myProposalCount: number;
                        name: string;
                        /** @enum {string} */
                        objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                        proposalCount: number | null;
                        revealedAt: string | null;
                        /** @enum {string} */
                        state: "OPEN" | "REVEALED" | "CLOSED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getCardSortBoard: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        canSeeTally: boolean;
                        factor: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            options: {
                                label: string;
                                value: string;
                            }[];
                        };
                        isFacilitator: boolean;
                        proposals: {
                            fromValue: string | null;
                            isMine: boolean;
                            /** Format: uuid */
                            objectId: string;
                            proposedValue: string;
                            rationale: string | null;
                            /** Format: uuid */
                            userId: string;
                            userName: string;
                        }[];
                        round: {
                            closedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdById: string;
                            factorName: string;
                            /** Format: uuid */
                            fieldDefinitionId: string;
                            /** Format: uuid */
                            id: string;
                            myProposalCount: number;
                            name: string;
                            /** @enum {string} */
                            objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                            proposalCount: number | null;
                            revealedAt: string | null;
                            /** @enum {string} */
                            state: "OPEN" | "REVEALED" | "CLOSED";
                        };
                        rows: {
                            currentValue: string | null;
                            myProposedValue: string | null;
                            myRationale: string | null;
                            /** Format: uuid */
                            objectId: string;
                            title: string;
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    closeCardSortRound: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        closedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        createdById: string;
                        factorName: string;
                        /** Format: uuid */
                        fieldDefinitionId: string;
                        /** Format: uuid */
                        id: string;
                        myProposalCount: number;
                        name: string;
                        /** @enum {string} */
                        objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                        proposalCount: number | null;
                        revealedAt: string | null;
                        /** @enum {string} */
                        state: "OPEN" | "REVEALED" | "CLOSED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCardSortNewEntries: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            acceptedObjectId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            isMine: boolean;
                            resolutionNote: string | null;
                            resolvedAt: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "ACCEPTED" | "REJECTED";
                            suggestedValue: string | null;
                            title: string;
                            /** Format: uuid */
                            userId: string;
                            userName: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    proposeCardSortNewEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    suggestedValue?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        acceptedObjectId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        description: string | null;
                        /** Format: uuid */
                        id: string;
                        isMine: boolean;
                        resolutionNote: string | null;
                        resolvedAt: string | null;
                        /** @enum {string} */
                        status: "PENDING" | "ACCEPTED" | "REJECTED";
                        suggestedValue: string | null;
                        title: string;
                        /** Format: uuid */
                        userId: string;
                        userName: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    withdrawCardSortNewEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    acceptCardSortNewEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        entryId: string;
                        /** Format: uuid */
                        opportunityId: string;
                        suggestionRecorded: boolean;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    rejectCardSortNewEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    note?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        entryId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCardSortProposals: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            fromValue: string | null;
                            /** Format: uuid */
                            objectId: string;
                            objectTitle: string;
                            proposedValue: string;
                            rationale: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    proposeCardSortMoves: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    objectIds: string[];
                    proposedValue: string;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        applied: string[];
                        skipped: {
                            /** @enum {string} */
                            code: "NOT_FOUND" | "INVALID_FACTOR" | "WRONG_STATE" | "INVALID_VALUE" | "NO_OP" | "HIDDEN_UNTIL_REVEALED" | "FORBIDDEN";
                            /** Format: uuid */
                            objectId: string;
                            reason: string;
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    withdrawCardSortProposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    revealCardSortRound: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        closedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        createdById: string;
                        factorName: string;
                        /** Format: uuid */
                        fieldDefinitionId: string;
                        /** Format: uuid */
                        id: string;
                        myProposalCount: number;
                        name: string;
                        /** @enum {string} */
                        objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                        proposalCount: number | null;
                        revealedAt: string | null;
                        /** @enum {string} */
                        state: "OPEN" | "REVEALED" | "CLOSED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getCardSortTally: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contested: {
                            currentValue: string | null;
                            distinctTargetCount: number;
                            /** Format: uuid */
                            objectId: string;
                            proposalCount: number;
                            targets: {
                                count: number;
                                proposers: {
                                    rationale: string | null;
                                    /** Format: uuid */
                                    userId: string;
                                    userName: string;
                                }[];
                                value: string;
                            }[];
                            title: string;
                            unanimousMove: boolean;
                        }[];
                        flow: {
                            buckets: {
                                inflow: number;
                                net: number;
                                outflow: number;
                                value: string;
                            }[];
                            edges: {
                                count: number;
                                from: string | null;
                                to: string;
                            }[];
                            fromUnsetCount: number;
                        };
                        objects: {
                            currentValue: string | null;
                            distinctTargetCount: number;
                            /** Format: uuid */
                            objectId: string;
                            proposalCount: number;
                            targets: {
                                count: number;
                                proposers: {
                                    rationale: string | null;
                                    /** Format: uuid */
                                    userId: string;
                                    userName: string;
                                }[];
                                value: string;
                            }[];
                            title: string;
                            unanimousMove: boolean;
                        }[];
                        options: {
                            label: string;
                            value: string;
                        }[];
                        participantCount: number;
                        proposalCount: number;
                        round: {
                            factorName: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            state: "OPEN" | "REVEALED" | "CLOSED";
                        };
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        docAnchor?: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string;
                            /** Format: uuid */
                            commentId: string;
                        } | null;
                        elementAnchor?: {
                            /** Format: uuid */
                            artifactId: string;
                            artifactRevisionId: string | null;
                            /** Format: uuid */
                            commentId: string;
                            elementFingerprint: unknown | null;
                            elementSelector: string | null;
                            pagePath: string;
                            pageUrl: string;
                            screenshotUrl: string | null;
                        } | null;
                        externalAuthor?: {
                            /** Format: uuid */
                            commentId: string;
                            embedTokenId: string | null;
                            portalAccountId: string | null;
                            submitterEmail: string | null;
                        } | null;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        solutionPlanProposal?: {
                            /** Format: uuid */
                            commentId: string;
                            legacyPlanStatus: string | null;
                            trackedDecisionRequestId: string | null;
                        } | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        docAnchor?: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string;
                            /** Format: uuid */
                            commentId: string;
                        } | null;
                        elementAnchor?: {
                            /** Format: uuid */
                            artifactId: string;
                            artifactRevisionId: string | null;
                            /** Format: uuid */
                            commentId: string;
                            elementFingerprint: unknown | null;
                            elementSelector: string | null;
                            pagePath: string;
                            pageUrl: string;
                            screenshotUrl: string | null;
                        } | null;
                        externalAuthor?: {
                            /** Format: uuid */
                            commentId: string;
                            embedTokenId: string | null;
                            portalAccountId: string | null;
                            submitterEmail: string | null;
                        } | null;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        solutionPlanProposal?: {
                            /** Format: uuid */
                            commentId: string;
                            legacyPlanStatus: string | null;
                            trackedDecisionRequestId: string | null;
                        } | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    } | {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    resolveComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        docAnchor?: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string;
                            /** Format: uuid */
                            commentId: string;
                        } | null;
                        elementAnchor?: {
                            /** Format: uuid */
                            artifactId: string;
                            artifactRevisionId: string | null;
                            /** Format: uuid */
                            commentId: string;
                            elementFingerprint: unknown | null;
                            elementSelector: string | null;
                            pagePath: string;
                            pageUrl: string;
                            screenshotUrl: string | null;
                        } | null;
                        externalAuthor?: {
                            /** Format: uuid */
                            commentId: string;
                            embedTokenId: string | null;
                            portalAccountId: string | null;
                            submitterEmail: string | null;
                        } | null;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        solutionPlanProposal?: {
                            /** Format: uuid */
                            commentId: string;
                            legacyPlanStatus: string | null;
                            trackedDecisionRequestId: string | null;
                        } | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    } | {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    reopenComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        docAnchor?: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string;
                            /** Format: uuid */
                            commentId: string;
                        } | null;
                        elementAnchor?: {
                            /** Format: uuid */
                            artifactId: string;
                            artifactRevisionId: string | null;
                            /** Format: uuid */
                            commentId: string;
                            elementFingerprint: unknown | null;
                            elementSelector: string | null;
                            pagePath: string;
                            pageUrl: string;
                            screenshotUrl: string | null;
                        } | null;
                        externalAuthor?: {
                            /** Format: uuid */
                            commentId: string;
                            embedTokenId: string | null;
                            portalAccountId: string | null;
                            submitterEmail: string | null;
                        } | null;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        solutionPlanProposal?: {
                            /** Format: uuid */
                            commentId: string;
                            legacyPlanStatus: string | null;
                            trackedDecisionRequestId: string | null;
                        } | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    } | {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listComments: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                status?: "OPEN" | "RESOLVED";
            };
            header?: never;
            path: {
                targetId: string;
                targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            authorId: string | null;
                            authorName: string;
                            /** @enum {string} */
                            authorType: "AGENT" | "HUMAN";
                            body: string;
                            /** Format: date-time */
                            createdAt: string;
                            docAnchor?: {
                                anchorEnd: number | null;
                                anchorPrefix: string | null;
                                anchorStart: number | null;
                                anchorSuffix: string | null;
                                anchorText: string;
                                /** Format: uuid */
                                commentId: string;
                            } | null;
                            elementAnchor?: {
                                /** Format: uuid */
                                artifactId: string;
                                artifactRevisionId: string | null;
                                /** Format: uuid */
                                commentId: string;
                                elementFingerprint: unknown | null;
                                elementSelector: string | null;
                                pagePath: string;
                                pageUrl: string;
                                screenshotUrl: string | null;
                            } | null;
                            externalAuthor?: {
                                /** Format: uuid */
                                commentId: string;
                                embedTokenId: string | null;
                                portalAccountId: string | null;
                                submitterEmail: string | null;
                            } | null;
                            /** Format: uuid */
                            id: string;
                            parentId: string | null;
                            solutionPlanProposal?: {
                                /** Format: uuid */
                                commentId: string;
                                legacyPlanStatus: string | null;
                                trackedDecisionRequestId: string | null;
                            } | null;
                            source: string;
                            /** @enum {string} */
                            status: "OPEN" | "RESOLVED";
                            /** Format: uuid */
                            targetId: string;
                            /** @enum {string} */
                            targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                targetId: string;
                targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                    /** Format: uuid */
                    parentId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        docAnchor?: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string;
                            /** Format: uuid */
                            commentId: string;
                        } | null;
                        elementAnchor?: {
                            /** Format: uuid */
                            artifactId: string;
                            artifactRevisionId: string | null;
                            /** Format: uuid */
                            commentId: string;
                            elementFingerprint: unknown | null;
                            elementSelector: string | null;
                            pagePath: string;
                            pageUrl: string;
                            screenshotUrl: string | null;
                        } | null;
                        externalAuthor?: {
                            /** Format: uuid */
                            commentId: string;
                            embedTokenId: string | null;
                            portalAccountId: string | null;
                            submitterEmail: string | null;
                        } | null;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        solutionPlanProposal?: {
                            /** Format: uuid */
                            commentId: string;
                            legacyPlanStatus: string | null;
                            trackedDecisionRequestId: string | null;
                        } | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST";
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    } | {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCustomFieldDefinitions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                objectType?: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            fieldType: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            objectType: string;
                            options: unknown[] | null;
                            order: number;
                            required: boolean;
                            sharedOptionSetId: string | null;
                            sharedOptionSetName: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCustomFieldValues: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                objectId: string;
                objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            currentValue: unknown | null;
                            fieldType: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            objectType: string;
                            options: unknown[] | null;
                            order: number;
                            required: boolean;
                            sharedOptionSetId: string | null;
                            sharedOptionSetName: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    setCustomFieldValue: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                objectId: string;
                objectType: "OPPORTUNITY" | "SOLUTION" | "EXPERIMENT" | "OBJECTIVE" | "KEY_RESULT" | "ROADMAP_ITEM" | "TASK";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    fieldId: string;
                    value: unknown | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        currentValue: unknown | null;
                        fieldType: string;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        objectType: string;
                        options: unknown[] | null;
                        order: number;
                        required: boolean;
                        sharedOptionSetId: string | null;
                        sharedOptionSetName: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDecisions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                status?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            answers?: unknown[];
                            artifacts?: {
                                currentRevision: {
                                    revisionNumber: number;
                                } | null;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                                /** @enum {string} */
                                status: "ACTIVE" | "ARCHIVED";
                                title: string;
                            }[];
                            assignedToId: string | null;
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            currentRevision?: ({
                                answers?: unknown[];
                                chosenOption?: {
                                    actionKey?: string;
                                    description?: string | null;
                                    /** Format: uuid */
                                    id?: string;
                                    label: string;
                                    outcomeClass?: string;
                                } | null;
                                /** Format: date-time */
                                createdAt: string;
                                decisions?: {
                                    actorRole: string;
                                    /** Format: uuid */
                                    actorUserId: string;
                                    answersJson: string | null;
                                    /** Format: date-time */
                                    decidedAt: string;
                                    fingerprint: string;
                                    /** Format: uuid */
                                    id: string;
                                    idempotencyKey: string;
                                    option?: {
                                        actionKey: string;
                                        continuationKey: string;
                                        /** Format: date-time */
                                        createdAt: string;
                                        description: string | null;
                                        /** Format: uuid */
                                        id: string;
                                        label: string;
                                        outcomeClass: string;
                                        /** Format: uuid */
                                        revisionId: string;
                                        sortOrder: number;
                                    };
                                    /** Format: uuid */
                                    optionId: string;
                                    rationale: string | null;
                                    /** Format: uuid */
                                    requestId: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    /** Format: uuid */
                                    workspaceId: string;
                                }[];
                                expiresAt: string | null;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                options?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                }[];
                                packetJson: string;
                                questions?: unknown[];
                                /** Format: uuid */
                                requestId: string;
                                requiredRole: string;
                                reviewUrl?: string | null;
                                revisionNumber: number;
                                sourceFingerprint: string | null;
                                summary: string | null;
                                supersededAt: string | null;
                                title: string;
                            } | {
                                fingerprint: string;
                                title: string;
                            }) | null;
                            currentRevisionId: string | null;
                            decisionCycle: number;
                            dueAt: string | null;
                            expiresAt: string | null;
                            followUpTasks?: {
                                /** Format: uuid */
                                id: string;
                                status: string;
                                title: string;
                            }[];
                            gateType: string;
                            /** Format: uuid */
                            id: string;
                            noAction?: {
                                /** Format: date-time */
                                at: string;
                                reason: string | null;
                            } | null;
                            noActionAt: string | null;
                            noActionById: string | null;
                            noActionReason: string | null;
                            options?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            }[];
                            questions?: unknown[];
                            reconsidersDecisionId: string | null;
                            reopenedById: string | null;
                            reopenReason: string | null;
                            requestedBy?: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                                type: string;
                            } | null;
                            requestedByAgentId: string | null;
                            requestedById: string | null;
                            reviewUrl?: string | null;
                            revisionCount: number;
                            revisions?: {
                                answers?: unknown[];
                                chosenOption?: {
                                    actionKey?: string;
                                    description?: string | null;
                                    /** Format: uuid */
                                    id?: string;
                                    label: string;
                                    outcomeClass?: string;
                                } | null;
                                /** Format: date-time */
                                createdAt: string;
                                decisions?: {
                                    actorRole: string;
                                    /** Format: uuid */
                                    actorUserId: string;
                                    answersJson: string | null;
                                    /** Format: date-time */
                                    decidedAt: string;
                                    fingerprint: string;
                                    /** Format: uuid */
                                    id: string;
                                    idempotencyKey: string;
                                    option?: {
                                        actionKey: string;
                                        continuationKey: string;
                                        /** Format: date-time */
                                        createdAt: string;
                                        description: string | null;
                                        /** Format: uuid */
                                        id: string;
                                        label: string;
                                        outcomeClass: string;
                                        /** Format: uuid */
                                        revisionId: string;
                                        sortOrder: number;
                                    };
                                    /** Format: uuid */
                                    optionId: string;
                                    rationale: string | null;
                                    /** Format: uuid */
                                    requestId: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    /** Format: uuid */
                                    workspaceId: string;
                                }[];
                                expiresAt: string | null;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                options?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                }[];
                                packetJson: string;
                                questions?: unknown[];
                                /** Format: uuid */
                                requestId: string;
                                requiredRole: string;
                                reviewUrl?: string | null;
                                revisionNumber: number;
                                sourceFingerprint: string | null;
                                summary: string | null;
                                supersededAt: string | null;
                                title: string;
                            }[];
                            state: string;
                            /** Format: uuid */
                            subjectId: string;
                            subjectType: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    requestDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    context: string;
                    /** Format: uuid */
                    idempotencyKey?: string;
                    /** @description Single-choice answers for the human to pick from (2-4). Omit for the standard Approve / Request changes / Reject. */
                    options?: {
                        /** @description Optional one-to-two sentence explanation of what choosing this option means. */
                        description?: string;
                        /** @description Short choice label shown on the button. Unique (case-insensitive) within the request; "Request changes" and "Reject" are reserved. */
                        label: string;
                    }[];
                    question: string;
                    /** @description Ask 1-4 questions in one request, each with its own single-choice options (like AskUserQuestion's questions[]). The human answers every question and submits once. Mutually exclusive with `options`. Omit for a single-question request. */
                    questions?: {
                        /** @description Optional short label for the question (up to 40 characters), e.g. "Database". */
                        header?: string;
                        /** @description 2-4 single-choice answers for this question. */
                        options: {
                            /** @description Optional one-to-two sentence explanation of what choosing this option means. */
                            description?: string;
                            /** @description Short choice label. Unique (case-insensitive) within this question; "Request changes" and "Reject" are reserved. */
                            label: string;
                        }[];
                        /** @description The question the human answers by picking one option. */
                        question: string;
                    }[];
                    sources?: {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        type: "WORKSPACE" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "ROADMAP_ITEM" | "DOC" | "EXPERIMENT" | "FEEDBACK" | "EVIDENCE";
                    }[];
                    /** Format: uuid */
                    subjectId: string;
                    /** @enum {string} */
                    subjectType: "WORKSPACE" | "OPPORTUNITY" | "SOLUTION" | "ROADMAP_ITEM" | "DOC" | "EXPERIMENT" | "FEEDBACK";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        answers?: unknown[];
                        chosenOption?: {
                            actionKey?: string;
                            description?: string | null;
                            /** Format: uuid */
                            id?: string;
                            label: string;
                            outcomeClass?: string;
                        } | null;
                        /** Format: date-time */
                        createdAt: string;
                        decisions?: {
                            actorRole: string;
                            /** Format: uuid */
                            actorUserId: string;
                            answersJson: string | null;
                            /** Format: date-time */
                            decidedAt: string;
                            fingerprint: string;
                            /** Format: uuid */
                            id: string;
                            idempotencyKey: string;
                            option?: {
                                actionKey: string;
                                continuationKey: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                label: string;
                                outcomeClass: string;
                                /** Format: uuid */
                                revisionId: string;
                                sortOrder: number;
                            };
                            /** Format: uuid */
                            optionId: string;
                            rationale: string | null;
                            /** Format: uuid */
                            requestId: string;
                            /** Format: uuid */
                            revisionId: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        expiresAt: string | null;
                        fingerprint: string;
                        /** Format: uuid */
                        id: string;
                        options?: {
                            actionKey: string;
                            continuationKey: string;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            label: string;
                            outcomeClass: string;
                            /** Format: uuid */
                            revisionId: string;
                            sortOrder: number;
                        }[];
                        packetJson: string;
                        questions?: unknown[];
                        /** Format: uuid */
                        requestId: string;
                        requiredRole: string;
                        reviewUrl?: string | null;
                        revisionNumber: number;
                        sourceFingerprint: string | null;
                        summary: string | null;
                        supersededAt: string | null;
                        title: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        answers?: unknown[];
                        artifacts?: {
                            currentRevision: {
                                revisionNumber: number;
                            } | null;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                            /** @enum {string} */
                            status: "ACTIVE" | "ARCHIVED";
                            title: string;
                        }[];
                        assignedToId: string | null;
                        chosenOption?: {
                            actionKey?: string;
                            description?: string | null;
                            /** Format: uuid */
                            id?: string;
                            label: string;
                            outcomeClass?: string;
                        } | null;
                        /** Format: date-time */
                        createdAt: string;
                        currentRevision?: ({
                            answers?: unknown[];
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            decisions?: {
                                actorRole: string;
                                /** Format: uuid */
                                actorUserId: string;
                                answersJson: string | null;
                                /** Format: date-time */
                                decidedAt: string;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                option?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                };
                                /** Format: uuid */
                                optionId: string;
                                rationale: string | null;
                                /** Format: uuid */
                                requestId: string;
                                /** Format: uuid */
                                revisionId: string;
                                /** Format: uuid */
                                workspaceId: string;
                            }[];
                            expiresAt: string | null;
                            fingerprint: string;
                            /** Format: uuid */
                            id: string;
                            options?: {
                                actionKey: string;
                                continuationKey: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                label: string;
                                outcomeClass: string;
                                /** Format: uuid */
                                revisionId: string;
                                sortOrder: number;
                            }[];
                            packetJson: string;
                            questions?: unknown[];
                            /** Format: uuid */
                            requestId: string;
                            requiredRole: string;
                            reviewUrl?: string | null;
                            revisionNumber: number;
                            sourceFingerprint: string | null;
                            summary: string | null;
                            supersededAt: string | null;
                            title: string;
                        } | {
                            fingerprint: string;
                            title: string;
                        }) | null;
                        currentRevisionId: string | null;
                        decisionCycle: number;
                        dueAt: string | null;
                        expiresAt: string | null;
                        followUpTasks?: {
                            /** Format: uuid */
                            id: string;
                            status: string;
                            title: string;
                        }[];
                        gateType: string;
                        /** Format: uuid */
                        id: string;
                        noAction?: {
                            /** Format: date-time */
                            at: string;
                            reason: string | null;
                        } | null;
                        noActionAt: string | null;
                        noActionById: string | null;
                        noActionReason: string | null;
                        options?: {
                            actionKey?: string;
                            description?: string | null;
                            /** Format: uuid */
                            id?: string;
                            label: string;
                            outcomeClass?: string;
                        }[];
                        questions?: unknown[];
                        reconsidersDecisionId: string | null;
                        reopenedById: string | null;
                        reopenReason: string | null;
                        requestedBy?: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            type: string;
                        } | null;
                        requestedByAgentId: string | null;
                        requestedById: string | null;
                        reviewUrl?: string | null;
                        revisionCount: number;
                        revisions?: {
                            answers?: unknown[];
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            decisions?: {
                                actorRole: string;
                                /** Format: uuid */
                                actorUserId: string;
                                answersJson: string | null;
                                /** Format: date-time */
                                decidedAt: string;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                option?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                };
                                /** Format: uuid */
                                optionId: string;
                                rationale: string | null;
                                /** Format: uuid */
                                requestId: string;
                                /** Format: uuid */
                                revisionId: string;
                                /** Format: uuid */
                                workspaceId: string;
                            }[];
                            expiresAt: string | null;
                            fingerprint: string;
                            /** Format: uuid */
                            id: string;
                            options?: {
                                actionKey: string;
                                continuationKey: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                label: string;
                                outcomeClass: string;
                                /** Format: uuid */
                                revisionId: string;
                                sortOrder: number;
                            }[];
                            packetJson: string;
                            questions?: unknown[];
                            /** Format: uuid */
                            requestId: string;
                            requiredRole: string;
                            reviewUrl?: string | null;
                            revisionNumber: number;
                            sourceFingerprint: string | null;
                            summary: string | null;
                            supersededAt: string | null;
                            title: string;
                        }[];
                        state: string;
                        /** Format: uuid */
                        subjectId: string;
                        subjectType: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    resolveDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    reopenDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDocVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        content?: string | null;
                        /** Format: date-time */
                        createdAt?: string;
                        createdById?: string | null;
                        createdByName?: string | null;
                        /** Format: uuid */
                        docId?: string;
                        icon?: string | null;
                        /** Format: uuid */
                        id: string;
                        label?: string | null;
                        metadata?: {
                            [key: string]: unknown;
                        } | null;
                        /** Format: date-time */
                        restoredFrom?: string;
                        revision?: string | number;
                        storageProvider?: string | null;
                        title: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    restoreDocVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedRevision: string;
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        content?: string | null;
                        /** Format: date-time */
                        createdAt?: string;
                        createdById?: string | null;
                        createdByName?: string | null;
                        /** Format: uuid */
                        docId?: string;
                        icon?: string | null;
                        /** Format: uuid */
                        id: string;
                        label?: string | null;
                        metadata?: {
                            [key: string]: unknown;
                        } | null;
                        /** Format: date-time */
                        restoredFrom?: string;
                        revision?: string | number;
                        storageProvider?: string | null;
                        title: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDocs: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: date-time */
                            createdAt: string;
                            /** @enum {string} */
                            docType: "STANDARD" | "GTM_POSITIONING_BRIEF" | "CANVAS";
                            icon: string | null;
                            /** Format: uuid */
                            id: string;
                            parentId: string | null;
                            revision: string | number;
                            roadmapItemId: string | null;
                            title: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: string;
                    /** @enum {string} */
                    docType?: "STANDARD" | "GTM_POSITIONING_BRIEF" | "CANVAS";
                    icon?: string;
                    /** Format: uuid */
                    operationId: string;
                    parentId?: string | null;
                    roadmapItemId?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        revision: string | number;
                        storageProvider: string;
                        title: string;
                        url: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        content: string;
                        /** @enum {string} */
                        docType: "STANDARD" | "GTM_POSITIONING_BRIEF" | "CANVAS";
                        /** Format: uuid */
                        id: string;
                        properties: {
                            [key: string]: unknown;
                        } | null;
                        revision: string | number;
                        storageProvider: string;
                        title: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: string;
                    expectedRevision: string;
                    icon?: string;
                    /** Format: uuid */
                    operationId: string;
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        icon: string | null;
                        /** Format: uuid */
                        id: string;
                        revision: string | number;
                        title: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDocComments: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                status?: "OPEN" | "RESOLVED";
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            anchorEnd: number | null;
                            anchorPrefix: string | null;
                            anchorStart: number | null;
                            anchorSuffix: string | null;
                            anchorText: string | null;
                            authorId: string | null;
                            authorName: string;
                            /** @enum {string} */
                            authorType: "AGENT" | "HUMAN";
                            body: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            docId: string;
                            /** Format: uuid */
                            id: string;
                            parentId: string | null;
                            source: string;
                            /** @enum {string} */
                            status: "OPEN" | "RESOLVED";
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createDocComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    anchorEnd?: number;
                    anchorPrefix?: string;
                    anchorStart?: number;
                    anchorSuffix?: string;
                    anchorText?: string;
                    body: string;
                    /** Format: uuid */
                    parentId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        anchorEnd: number | null;
                        anchorPrefix: string | null;
                        anchorStart: number | null;
                        anchorSuffix: string | null;
                        anchorText: string | null;
                        authorId: string | null;
                        authorName: string;
                        /** @enum {string} */
                        authorType: "AGENT" | "HUMAN";
                        body: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        docId: string;
                        /** Format: uuid */
                        id: string;
                        parentId: string | null;
                        source: string;
                        /** @enum {string} */
                        status: "OPEN" | "RESOLVED";
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    prepareDocImageUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    filename: string;
                    fileSize: number;
                    /** @enum {string} */
                    fileType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        access: "private";
                        clientToken: string;
                        expiresAt: string | number;
                        filename: string;
                        fileSize: number;
                        /** @enum {string} */
                        fileType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                        /** Format: uuid */
                        imageId: string;
                        imageName: string;
                        markdown: string;
                        pathname: string;
                        url: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDocVersions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: date-time */
                            createdAt: string;
                            createdByName: string | null;
                            /** Format: uuid */
                            docId: string;
                            /** Format: uuid */
                            id: string;
                            label: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createDocVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedRevision: string;
                    label?: string;
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        label?: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listEntityLinks: {
        parameters: {
            query: {
                cursor?: string;
                entityId?: string;
                entityType?: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST" | "METRIC" | "RESEARCH_TURN";
                keyResultId?: string;
                limit: number;
                linkType?: string;
                objectiveId?: string;
                opportunityId?: string;
                solutionId?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            from?: {
                                /** Format: uuid */
                                id: string;
                                title: string;
                                type: string;
                            };
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            keyResultId?: string;
                            keyResultTitle?: string;
                            /** @enum {string} */
                            kind: "opportunity_objective" | "solution_key_result" | "entity_link";
                            label?: string;
                            linkType?: string;
                            /** Format: uuid */
                            objectiveId?: string;
                            objectiveTitle?: string;
                            /** Format: uuid */
                            opportunityId?: string;
                            opportunityTitle?: string;
                            origin?: string;
                            /** @enum {string} */
                            side?: "from" | "to";
                            /** Format: uuid */
                            solutionId?: string;
                            solutionTitle?: string;
                            source: string;
                            to?: {
                                /** Format: uuid */
                                id: string;
                                title: string;
                                type: string;
                            };
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkEntities: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    fromId: string;
                    linkType: string;
                    /** Format: uuid */
                    toId: string;
                    /** @enum {string} */
                    toType?: "OBJECTIVE" | "KEY_RESULT" | "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT" | "ROADMAP_ITEM" | "FEEDBACK_ITEM" | "TASK" | "DOC" | "ARTIFACT" | "RESEARCH_STUDY" | "REVIEW_REQUEST" | "METRIC" | "RESEARCH_TURN";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        fromId: string;
                        fromType: string;
                        /** Format: uuid */
                        id: string;
                        linkType: string;
                        origin: string;
                        source: string;
                        /** Format: uuid */
                        toId: string;
                        toType: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkEntities: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fromId: string;
                linkType: string;
                toId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listEvidence: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                nodeId: string;
                nodeType: "opportunity" | "solution" | "assumption";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @enum {string} */
                            confidence: "high" | "medium" | "low";
                            excerpt: string;
                            /** Format: uuid */
                            id: string;
                            parent: {
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                type: "opportunity" | "solution" | "assumption";
                            };
                            research?: {
                                /** Format: uuid */
                                researchSynthesisId: string;
                                sources: {
                                    /** Format: uuid */
                                    researchTurnId: string;
                                    resolved: boolean;
                                    role: string | null;
                                    sequence: number | null;
                                    sessionId: string | null;
                                    studyId: string | null;
                                }[];
                            };
                            /** @enum {string} */
                            sourceType: "interview" | "feedback" | "support_ticket" | "experiment_result" | "analytics";
                            sourceUrl: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    confidence?: "high" | "medium" | "low";
                    excerpt: string;
                    /** @enum {string} */
                    sourceType: "interview" | "feedback" | "support_ticket" | "experiment_result" | "analytics";
                    /** Format: uri */
                    sourceUrl?: string;
                } & ({
                    assumptionId?: unknown;
                    /** Format: uuid */
                    opportunityId: string;
                    solutionId?: unknown;
                } | {
                    assumptionId?: unknown;
                    opportunityId?: unknown;
                    /** Format: uuid */
                    solutionId: string;
                } | {
                    /** Format: uuid */
                    assumptionId: string;
                    opportunityId?: unknown;
                    solutionId?: unknown;
                });
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        confidence: "high" | "medium" | "low";
                        excerpt: string;
                        /** Format: uuid */
                        id: string;
                        parent: {
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            type: "opportunity" | "solution" | "assumption";
                        };
                        research?: {
                            /** Format: uuid */
                            researchSynthesisId: string;
                            sources: {
                                /** Format: uuid */
                                researchTurnId: string;
                                resolved: boolean;
                                role: string | null;
                                sequence: number | null;
                                sessionId: string | null;
                                studyId: string | null;
                            }[];
                        };
                        /** @enum {string} */
                        sourceType: "interview" | "feedback" | "support_ticket" | "experiment_result" | "analytics";
                        sourceUrl: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateEvidenceTarget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    assumptionId?: unknown;
                    /** Format: uuid */
                    opportunityId: string;
                    solutionId?: unknown;
                } | {
                    assumptionId?: unknown;
                    opportunityId?: unknown;
                    /** Format: uuid */
                    solutionId: string;
                } | {
                    /** Format: uuid */
                    assumptionId: string;
                    opportunityId?: unknown;
                    solutionId?: unknown;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        confidence: "high" | "medium" | "low";
                        excerpt: string;
                        /** Format: uuid */
                        id: string;
                        parent: {
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            type: "opportunity" | "solution" | "assumption";
                        };
                        research?: {
                            /** Format: uuid */
                            researchSynthesisId: string;
                            sources: {
                                /** Format: uuid */
                                researchTurnId: string;
                                resolved: boolean;
                                role: string | null;
                                sequence: number | null;
                                sessionId: string | null;
                                studyId: string | null;
                            }[];
                        };
                        /** @enum {string} */
                        sourceType: "interview" | "feedback" | "support_ticket" | "experiment_result" | "analytics";
                        sourceUrl: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listExperiments: {
        parameters: {
            query: {
                assumptionId?: string;
                cursor?: string;
                limit: number;
                squadId?: string;
                status?: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            assumptionId: string | null;
                            conclusion: string | null;
                            conclusionReason: string | null;
                            createdAt: string;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            endDate: string | null;
                            hypothesis: string;
                            /** Format: uuid */
                            id: string;
                            killCondition: string;
                            method: string;
                            squadId: string | null;
                            startDate: string | null;
                            /** @enum {string} */
                            status: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createExperiment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    assumptionId?: string | null;
                    hypothesis: string;
                    killCondition: string;
                    method: string;
                    squadId?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assumptionId: string | null;
                        conclusion: string | null;
                        conclusionReason: string | null;
                        createdAt: string;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        hypothesis: string;
                        /** Format: uuid */
                        id: string;
                        killCondition: string;
                        method: string;
                        squadId: string | null;
                        startDate: string | null;
                        /** @enum {string} */
                        status: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getExperiment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assumptionId: string | null;
                        conclusion: string | null;
                        conclusionReason: string | null;
                        createdAt: string;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        hypothesis: string;
                        /** Format: uuid */
                        id: string;
                        killCondition: string;
                        method: string;
                        squadId: string | null;
                        startDate: string | null;
                        /** @enum {string} */
                        status: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateExperiment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    expectedUpdatedAt: string;
                    hypothesis?: string;
                    killCondition?: string;
                    method?: string;
                    title?: string;
                } | {
                    /** Format: date-time */
                    expectedUpdatedAt: string;
                    squadId: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assumptionId: string | null;
                        conclusion: string | null;
                        conclusionReason: string | null;
                        createdAt: string;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        hypothesis: string;
                        /** Format: uuid */
                        id: string;
                        killCondition: string;
                        method: string;
                        squadId: string | null;
                        startDate: string | null;
                        /** @enum {string} */
                        status: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    concludeExperiment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    conclusion: "PROCEED" | "KILL" | "ITERATE" | "NOT_PURSUED";
                    /** Format: date-time */
                    expectedUpdatedAt: string;
                    reason?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assumptionId: string | null;
                        conclusion: string | null;
                        conclusionReason: string | null;
                        createdAt: string;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        hypothesis: string;
                        /** Format: uuid */
                        id: string;
                        killCondition: string;
                        method: string;
                        squadId: string | null;
                        startDate: string | null;
                        /** @enum {string} */
                        status: "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED" | "NOT_PURSUED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listExperimentResults: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            /** Format: uuid */
                            experimentId: string;
                            /** Format: uuid */
                            id: string;
                            metric: string | null;
                            note: string;
                            value: number | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createExperimentResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    metric?: string | null;
                    note: string;
                    value?: number | null;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        /** Format: uuid */
                        experimentId: string;
                        /** Format: uuid */
                        id: string;
                        metric: string | null;
                        note: string;
                        value: number | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listFeedback: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                opportunityId?: string;
                status?: "OPEN" | "UNDER_REVIEW" | "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "DECLINED" | "CLOSED";
                type?: "BUG" | "IDEA";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            opportunityId: string | null;
                            status: string;
                            submitterEmail: string | null;
                            submitterName: string | null;
                            tags: string[];
                            title: string;
                            type: string;
                            updatedAt: string;
                            voteCount: number;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createFeedback: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    submitterEmail?: string | null;
                    submitterName?: string | null;
                    title: string;
                    /** @enum {string} */
                    type?: "BUG" | "IDEA";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        opportunityId: string | null;
                        status: string;
                        submitterEmail: string | null;
                        submitterName: string | null;
                        tags: string[];
                        title: string;
                        type: string;
                        updatedAt: string;
                        voteCount: number;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    prepareFeedbackAttachmentUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    filename: string;
                    fileSize: number;
                    /** @enum {string} */
                    fileType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf" | "text/plain" | "text/csv";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        attachmentId: string;
                        clientToken: string;
                        expiresAt: number;
                        pathname: string;
                        receipt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createFeedbackSource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    allowedOrigins: string[];
                    /** Format: uuid */
                    artifactId: string;
                    /** @enum {string} */
                    authMode?: "INTERNAL_SSO" | "PORTAL";
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        allowedOrigins: string[];
                        /** @enum {string} */
                        authMode: "INTERNAL_SSO" | "PORTAL";
                        enabled?: boolean;
                        name?: string;
                        note?: string | null;
                        scriptPath?: string;
                        scriptUrl?: string | null;
                        snippet?: string | null;
                        /** Format: uuid */
                        sourceId: string;
                        token: string;
                        tokenPrefix?: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateFeedbackSource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    allowedOrigins?: string[];
                    /** @enum {string} */
                    authMode?: "INTERNAL_SSO" | "PORTAL";
                    enabled?: boolean;
                    name?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        allowedOrigins: string[];
                        /** @enum {string} */
                        authMode: "INTERNAL_SSO" | "PORTAL";
                        enabled?: boolean;
                        name?: string;
                        note?: string | null;
                        scriptPath?: string;
                        scriptUrl?: string | null;
                        snippet?: string | null;
                        /** Format: uuid */
                        sourceId: string;
                        tokenPrefix?: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getFeedback: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        opportunityId: string | null;
                        status: string;
                        submitterEmail: string | null;
                        submitterName: string | null;
                        tags: string[];
                        title: string;
                        type: string;
                        updatedAt: string;
                        voteCount: number;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateFeedback: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    title?: string;
                } | {
                    /** @enum {string} */
                    type: "BUG" | "IDEA";
                } | {
                    /** @enum {string} */
                    status: "OPEN" | "UNDER_REVIEW" | "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "DECLINED" | "CLOSED";
                } | {
                    /** Format: uuid */
                    opportunityId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        opportunityId: string | null;
                        status: string;
                        submitterEmail: string | null;
                        submitterName: string | null;
                        tags: string[];
                        title: string;
                        type: string;
                        updatedAt: string;
                        voteCount: number;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    completeFeedbackAttachmentUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    receipt: string;
                    /** Format: uri */
                    url: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        alreadyAttached: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        feedbackItemId: string;
                        feedbackUrl: string | null;
                        filename: string;
                        fileSize: number;
                        fileType: string;
                        /** Format: uuid */
                        id: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uri */
                        url: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    promoteFeedbackToRoadmap: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED";
                    isPrivate?: boolean;
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        experimentId: string | null;
                        feedbackId: string | null;
                        horizon: string;
                        /** Format: uuid */
                        id: string;
                        isPrivate: boolean;
                        keyResultId: string | null;
                        opportunityId: string | null;
                        solutionId: string | null;
                        squadId: string | null;
                        startDate: string | null;
                        status: string;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    followResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subjectId: string;
                subjectType: "OPPORTUNITY" | "SOLUTION" | "TASK" | "DOC";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "followed" | "already_following" | "unfollowed";
                        /** Format: uuid */
                        subjectId: string;
                        /** @enum {string} */
                        subjectType: "OPPORTUNITY" | "SOLUTION" | "TASK" | "DOC";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unfollowResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subjectId: string;
                subjectType: "OPPORTUNITY" | "SOLUTION" | "TASK" | "DOC";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        current: number;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        objectiveId: string;
                        sortOrder: number;
                        target: number;
                        title: string;
                        unit: string | null;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    current?: number;
                    target?: number;
                    title?: string;
                    unit?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        current: number;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        objectiveId: string;
                        sortOrder: number;
                        target: number;
                        title: string;
                        unit: string | null;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCheckIns: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            keyResultId: string;
                            note: string | null;
                            value: number;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createCheckIn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    note?: string | null;
                    value: number;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        keyResultId: string;
                        note: string | null;
                        value: number;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateLaunchChecklistItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    status: "PENDING" | "DONE" | "SKIPPED";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        status: "PENDING" | "DONE" | "SKIPPED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listChecklistTemplates: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                tier?: "TIER_1" | "TIER_2" | "TIER_3";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            description?: string | null;
                            /** Format: uuid */
                            id: string;
                            itemCount?: number;
                            items?: {
                                description?: string | null;
                                label: string;
                                order: number;
                            }[];
                            name: string;
                            status?: string;
                            /** @enum {string} */
                            tier: "TIER_1" | "TIER_2" | "TIER_3";
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createChecklistTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    items: {
                        description?: string;
                        label: string;
                    }[];
                    name: string;
                    /** @enum {string} */
                    tier: "TIER_1" | "TIER_2" | "TIER_3";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        description?: string | null;
                        /** Format: uuid */
                        id: string;
                        itemCount?: number;
                        items?: {
                            description?: string | null;
                            label: string;
                            order: number;
                        }[];
                        name: string;
                        status?: string;
                        /** @enum {string} */
                        tier: "TIER_1" | "TIER_2" | "TIER_3";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listMetricBindings: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                targetId: string;
                targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            active: boolean;
                            baseline: unknown | null;
                            createdAt: string;
                            followup: unknown;
                            /** Format: uuid */
                            id: string;
                            metric: {
                                archived: boolean;
                                connectionId: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                /** @enum {string} */
                                provider: "vercel" | "compass_activation";
                                query: {
                                    [key: string]: unknown;
                                };
                                revision: number;
                                /** Format: uuid */
                                revisionId: string;
                                unit: string;
                                /** Format: uuid */
                                workspaceId: string;
                            };
                            /** Format: uuid */
                            metricId: string;
                            mode: string;
                            /** Format: uuid */
                            replacesBindingId?: string;
                            /** Format: uuid */
                            revisionId: string;
                            /** Format: uuid */
                            targetId: string;
                            /** @enum {string} */
                            targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
                            targetValue: number | null;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createMetricBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    baseline?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | null;
                    followup?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | {
                        days: 7 | 30 | 90;
                        /** @constant */
                        mode: "rolling";
                        /** @constant */
                        version: 1;
                    };
                    /** Format: uuid */
                    metricId: string;
                    target?: number;
                    /** Format: uuid */
                    targetId: string;
                    /** @enum {string} */
                    targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        active: boolean;
                        baseline: unknown | null;
                        createdAt: string;
                        followup: unknown;
                        /** Format: uuid */
                        id: string;
                        metric: {
                            archived: boolean;
                            connectionId: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            provider: "vercel" | "compass_activation";
                            query: {
                                [key: string]: unknown;
                            };
                            revision: number;
                            /** Format: uuid */
                            revisionId: string;
                            unit: string;
                            /** Format: uuid */
                            workspaceId: string;
                        };
                        /** Format: uuid */
                        metricId: string;
                        mode: string;
                        /** Format: uuid */
                        replacesBindingId?: string;
                        /** Format: uuid */
                        revisionId: string;
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
                        targetValue: number | null;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getMetricBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        active: boolean;
                        baseline: unknown | null;
                        createdAt: string;
                        followup: unknown;
                        /** Format: uuid */
                        id: string;
                        metric: {
                            archived: boolean;
                            connectionId: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            provider: "vercel" | "compass_activation";
                            query: {
                                [key: string]: unknown;
                            };
                            revision: number;
                            /** Format: uuid */
                            revisionId: string;
                            unit: string;
                            /** Format: uuid */
                            workspaceId: string;
                        };
                        /** Format: uuid */
                        metricId: string;
                        mode: string;
                        /** Format: uuid */
                        replacesBindingId?: string;
                        /** Format: uuid */
                        revisionId: string;
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
                        targetValue: number | null;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteMetricBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateMetricBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    baseline: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | null;
                    followup?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | {
                        days: 7 | 30 | 90;
                        /** @constant */
                        mode: "rolling";
                        /** @constant */
                        version: 1;
                    };
                    target?: number | null;
                } | {
                    baseline?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | null;
                    followup: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | {
                        days: 7 | 30 | 90;
                        /** @constant */
                        mode: "rolling";
                        /** @constant */
                        version: 1;
                    };
                    target?: number | null;
                } | {
                    baseline?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | null;
                    followup?: {
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        since: string;
                        /**
                         * Format: date
                         * @description A valid ISO 8601 calendar date.
                         */
                        until: string;
                    } | {
                        days: 7 | 30 | 90;
                        /** @constant */
                        mode: "rolling";
                        /** @constant */
                        version: 1;
                    };
                    target: number | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        active: boolean;
                        baseline: unknown | null;
                        createdAt: string;
                        followup: unknown;
                        /** Format: uuid */
                        id: string;
                        metric: {
                            archived: boolean;
                            connectionId: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            provider: "vercel" | "compass_activation";
                            query: {
                                [key: string]: unknown;
                            };
                            revision: number;
                            /** Format: uuid */
                            revisionId: string;
                            unit: string;
                            /** Format: uuid */
                            workspaceId: string;
                        };
                        /** Format: uuid */
                        metricId: string;
                        mode: string;
                        /** Format: uuid */
                        replacesBindingId?: string;
                        /** Format: uuid */
                        revisionId: string;
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT";
                        targetValue: number | null;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listMetricObservations: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            bindingId: string;
                            data: {
                                [key: string]: unknown;
                            };
                            /** Format: uuid */
                            id: string;
                            retrievedAt: string;
                            /** Format: uuid */
                            revisionId: string;
                            snapshot: {
                                [key: string]: unknown;
                            };
                            windowKind: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    refreshMetricBinding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    requestId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        bindingId: string;
                        data: {
                            [key: string]: unknown;
                        };
                        /** Format: uuid */
                        id: string;
                        retrievedAt: string;
                        /** Format: uuid */
                        revisionId: string;
                        snapshot: {
                            [key: string]: unknown;
                        };
                        windowKind: string;
                        /** Format: uuid */
                        workspaceId: string;
                    }[];
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getMetricObservation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        bindingId: string;
                        data: {
                            [key: string]: unknown;
                        };
                        /** Format: uuid */
                        id: string;
                        retrievedAt: string;
                        /** Format: uuid */
                        revisionId: string;
                        snapshot: {
                            [key: string]: unknown;
                        };
                        windowKind: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listMetrics: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            archived: boolean;
                            connectionId: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            provider: "vercel" | "compass_activation";
                            query: {
                                [key: string]: unknown;
                            };
                            revision: number;
                            /** Format: uuid */
                            revisionId: string;
                            unit: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createMetric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    connectionId?: string;
                    name: string;
                    /** @enum {string} */
                    provider: "vercel" | "compass_activation";
                    query: {
                        eventName?: string;
                        eventProperties?: {
                            [key: string]: string;
                        };
                        flags?: {
                            [key: string]: string;
                        };
                        /** @enum {string} */
                        metric: "pageviews" | "daily_visitors" | "event_count" | "active_discovery_teams";
                        path?: string;
                    };
                    unit: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        archived: boolean;
                        connectionId: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** @enum {string} */
                        provider: "vercel" | "compass_activation";
                        query: {
                            [key: string]: unknown;
                        };
                        revision: number;
                        /** Format: uuid */
                        revisionId: string;
                        unit: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getMetric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        archived: boolean;
                        connectionId: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** @enum {string} */
                        provider: "vercel" | "compass_activation";
                        query: {
                            [key: string]: unknown;
                        };
                        revision: number;
                        /** Format: uuid */
                        revisionId: string;
                        unit: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    archiveMetric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateMetric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    connectionId?: string;
                    expectedRevision: number;
                    name: string;
                    /** @enum {string} */
                    provider: "vercel" | "compass_activation";
                    query: {
                        eventName?: string;
                        eventProperties?: {
                            [key: string]: string;
                        };
                        flags?: {
                            [key: string]: string;
                        };
                        /** @enum {string} */
                        metric: "pageviews" | "daily_visitors" | "event_count" | "active_discovery_teams";
                        path?: string;
                    };
                    unit: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        archived: boolean;
                        connectionId: string | null;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** @enum {string} */
                        provider: "vercel" | "compass_activation";
                        query: {
                            [key: string]: unknown;
                        };
                        revision: number;
                        /** Format: uuid */
                        revisionId: string;
                        unit: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listNotifications: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                unreadOnly?: unknown;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            actor: {
                                id: string | null;
                                name: string;
                                type: string;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            kind: string;
                            payload: {
                                [key: string]: string;
                            };
                            read: boolean;
                            readAt: string | null;
                            subject: {
                                path: string;
                                title: string;
                            } | null;
                            /** Format: uuid */
                            subjectId: string;
                            /** @enum {string} */
                            subjectType: "OPPORTUNITY" | "SOLUTION" | "TASK" | "DOC";
                        }[];
                        nextCursor: string | null;
                        unreadCount: number;
                        unreadOverflow: boolean;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    markNotificationsRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    notificationIds: string[];
                } | {
                    /** @constant */
                    all: true;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        marked: number;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listObjectives: {
        parameters: {
            query: {
                cursor?: string;
                cycleId?: string | null;
                limit: number;
                status?: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            cycleId: string | null;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            owner: string | null;
                            parentKeyResultId: string | null;
                            sortOrder: number;
                            squadId: string | null;
                            /** @enum {string} */
                            status: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    cycleId?: string | null;
                    description?: string | null;
                    owner?: string | null;
                    parentKeyResultId?: string | null;
                    squadId?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        cycleId: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        owner: string | null;
                        parentKeyResultId: string | null;
                        sortOrder: number;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        cycleId: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        owner: string | null;
                        parentKeyResultId: string | null;
                        sortOrder: number;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** @enum {string} */
                    status?: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
                    title?: string;
                } | {
                    squadId: string | null;
                } | {
                    parentKeyResultId: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        cycleId: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        owner: string | null;
                        parentKeyResultId: string | null;
                        sortOrder: number;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listEligibleParentKeyResults: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            cycleTitle: string;
                            /** Format: uuid */
                            id: string;
                            objectiveTitle: string;
                            title: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listKeyResults: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            current: number;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            objectiveId: string;
                            sortOrder: number;
                            target: number;
                            title: string;
                            unit: string | null;
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    target: number;
                    title: string;
                    unit?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        current: number;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        objectiveId: string;
                        sortOrder: number;
                        target: number;
                        title: string;
                        unit: string | null;
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listOkrCycles: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            endDate: string;
                            /** Format: uuid */
                            id: string;
                            startDate: string;
                            /** @enum {string} */
                            status: "DRAFT" | "ACTIVE" | "COMPLETED";
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createOkrCycle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date */
                    endDate: string;
                    /** Format: date */
                    startDate: string;
                    /** @enum {string} */
                    status?: "DRAFT" | "ACTIVE" | "COMPLETED";
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        endDate: string;
                        /** Format: uuid */
                        id: string;
                        startDate: string;
                        /** @enum {string} */
                        status: "DRAFT" | "ACTIVE" | "COMPLETED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getOkrCycle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        endDate: string;
                        /** Format: uuid */
                        id: string;
                        startDate: string;
                        /** @enum {string} */
                        status: "DRAFT" | "ACTIVE" | "COMPLETED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listOpportunities: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                squadId?: string;
                status?: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            customerSegment: string | null;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            linkedKeyResultId: string | null;
                            squadId: string | null;
                            /** @enum {string} */
                            status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createOpportunity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    customerSegment?: string | null;
                    description?: string | null;
                    linkedKeyResultId?: string | null;
                    squadId?: string | null;
                    /** @enum {string} */
                    status?: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE";
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        customerSegment: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        linkedKeyResultId: string | null;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getOpportunity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        customerSegment: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        linkedKeyResultId: string | null;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateOpportunity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    customerSegment?: string | null;
                    description?: string | null;
                    squadId?: string | null;
                    title?: string;
                } | {
                    /** @enum {string} */
                    status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
                } | {
                    linkedKeyResultId: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        customerSegment: string | null;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        linkedKeyResultId: string | null;
                        squadId: string | null;
                        /** @enum {string} */
                        status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkOpportunityObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    objectiveId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        objectiveId: string;
                        /** Format: uuid */
                        opportunityId: string;
                        origin: string;
                        source: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkOpportunityObjective: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getOpportunityScore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        formulaSnapshot: unknown;
                        /** Format: uuid */
                        id: string;
                        modelVersion: number;
                        normalizedScore: number;
                        rawScore: number;
                        rawValues: {
                            [key: string]: number;
                        };
                        scoredAt: string;
                        /** Format: uuid */
                        scoringModelId: string;
                        updatedAt: string;
                    } & ({
                        /** Format: uuid */
                        opportunityId: string;
                    } | {
                        /** Format: uuid */
                        solutionId: string;
                    });
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    scoreOpportunity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    values: {
                        [key: string]: number;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        formulaSnapshot: unknown;
                        /** Format: uuid */
                        id: string;
                        modelVersion: number;
                        normalizedScore: number;
                        rawScore: number;
                        rawValues: {
                            [key: string]: number;
                        };
                        scoredAt: string;
                        /** Format: uuid */
                        scoringModelId: string;
                        updatedAt: string;
                    } & ({
                        /** Format: uuid */
                        opportunityId: string;
                    } | {
                        /** Format: uuid */
                        solutionId: string;
                    });
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createOpportunitiesBatch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    items: {
                        /** Format: uuid */
                        clientId?: string;
                        customerSegment?: string | null;
                        description?: string | null;
                        squadId?: string | null;
                        status?: string;
                        title: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: ({
                            /** Format: uuid */
                            clientId: string;
                            /** @constant */
                            deduped?: true;
                            /** Format: uuid */
                            id: string;
                            /** @constant */
                            ok: true;
                        } | {
                            clientId: string;
                            /** @enum {string} */
                            code: "INVALID" | "PARENT_FAILED" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL";
                            error: string;
                            field?: string;
                            /** @constant */
                            ok: false;
                        })[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listWorkspaceOpportunityRankings: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            normalizedScore: number;
                            /** Format: uuid */
                            opportunityId: string;
                            status: string;
                            title: string;
                            workspace: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getPmInterview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        agentConversationId: string | null;
                        applicationDisabledReason: string | null;
                        context: {
                            /** Format: date-time */
                            capturedAt: string;
                            evidence: {
                                excerpt: string;
                                /** Format: uuid */
                                id: string;
                            }[];
                            feedback: {
                                excerpt: string;
                                /** Format: uuid */
                                id: string;
                            }[];
                            linkedObjectives?: {
                                /** Format: uuid */
                                id: string;
                                title: string;
                            }[];
                            omissions: string[];
                            outcome: {
                                /** Format: uuid */
                                id: string;
                                title: string;
                            } | null;
                            parents: {
                                /** Format: uuid */
                                id: string;
                                title: string;
                                type: string;
                            }[];
                            target: {
                                fields: {
                                    customerSegment: string | null;
                                    description: string | null;
                                    status: string;
                                    title: string;
                                };
                                /** Format: uuid */
                                id: string;
                                /** @constant */
                                type: "OPPORTUNITY";
                            } | {
                                fields: {
                                    description: string | null;
                                    status: string;
                                    title: string;
                                };
                                /** Format: uuid */
                                id: string;
                                /** @constant */
                                type: "SOLUTION";
                            } | {
                                fields: {
                                    description: string | null;
                                    riskLevel: string;
                                    status: string;
                                    title: string;
                                };
                                /** Format: uuid */
                                id: string;
                                /** @constant */
                                type: "ASSUMPTION";
                            } | {
                                fields: {
                                    hypothesis: string;
                                    killCondition: string;
                                    method: string;
                                    status: string;
                                    title: string;
                                };
                                /** Format: uuid */
                                id: string;
                                /** @constant */
                                type: "EXPERIMENT";
                            };
                            /** @constant */
                            version: 1;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        disposition: string;
                        generationFailureCode: string | null;
                        generationState: string;
                        /** Format: uuid */
                        id: string;
                        owner: boolean;
                        proposal: ({
                            brief: string;
                            openQuestions: string[];
                            proposedFields: {
                                customerSegment?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                description?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                title?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                            };
                            suggestedNextSteps: string[];
                            unknowns: string[];
                            /** @constant */
                            version: 1;
                        } | {
                            brief: string;
                            openQuestions: string[];
                            proposedFields: {
                                description?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                title?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                            };
                            suggestedNextSteps: string[];
                            unknowns: string[];
                            /** @constant */
                            version: 1;
                        } | {
                            brief: string;
                            openQuestions: string[];
                            proposedFields: {
                                hypothesis?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                killCondition?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                method?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                                title?: {
                                    transcriptTurnIds: string[];
                                    value: string | null;
                                };
                            };
                            suggestedNextSteps: string[];
                            unknowns: string[];
                            /** @constant */
                            version: 1;
                        }) | null;
                        receipt: ({
                            /** Format: date-time */
                            at: string;
                            /** @constant */
                            kind: "DISMISSED";
                            /** @constant */
                            version: 1;
                        } | {
                            after: {
                                customerSegment?: string | null;
                                description?: string | null;
                                title?: string;
                            };
                            /** Format: date-time */
                            at: string;
                            before: {
                                customerSegment?: string | null;
                                description?: string | null;
                                title?: string;
                            };
                            /** @constant */
                            kind: "APPLIED";
                            selectedFields: ("title" | "description" | "customerSegment")[];
                            /** @constant */
                            version: 1;
                        } | {
                            after: {
                                description?: string | null;
                                title?: string;
                            };
                            /** Format: date-time */
                            at: string;
                            before: {
                                description?: string | null;
                                title?: string;
                            };
                            /** @constant */
                            kind: "APPLIED";
                            selectedFields: ("title" | "description")[];
                            /** @constant */
                            version: 1;
                        } | {
                            after: {
                                hypothesis?: string;
                                killCondition?: string;
                                method?: string;
                                title?: string;
                            };
                            /** Format: date-time */
                            at: string;
                            before: {
                                hypothesis?: string;
                                killCondition?: string;
                                method?: string;
                                title?: string;
                            };
                            /** @constant */
                            kind: "APPLIED";
                            selectedFields: ("title" | "hypothesis" | "method" | "killCondition")[];
                            /** @constant */
                            version: 1;
                        }) | null;
                        reviewBaseline: {
                            fields: {
                                customerSegment: string | null;
                                description: string | null;
                                title: string;
                            } | {
                                description: string | null;
                                title: string;
                            } | {
                                hypothesis: string;
                                killCondition: string;
                                method: string;
                                title: string;
                            };
                            /** @constant */
                            version: 1;
                        };
                        session: {
                            /** Format: uuid */
                            id: string;
                            modality: string;
                            status: string;
                            turns: {
                                content: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                role: "PARTICIPANT" | "INTERVIEWER";
                                sequence: number;
                            }[];
                        };
                        /** Format: uuid */
                        targetId: string;
                        /** @enum {string} */
                        targetType: "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT";
                        /** Format: date-time */
                        updatedAt: string;
                        /** @constant */
                        version: 1;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    requestReleaseAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    baseRef: string;
                    headSha: string;
                    /** @constant */
                    provider: "GITHUB";
                    pullRequestNumber: number;
                    releasePolicyId: string;
                    repositoryName: string;
                    repositoryOwner: string;
                    /** @constant */
                    targetEnvironment: "PRODUCTION";
                    taskIds: string[];
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        releaseRunId: string;
                        /** Format: uuid */
                        requestId: string;
                        reviewFingerprint: string;
                        reviewUrl: string | null;
                        /** Format: uuid */
                        revisionId: string;
                        sourceFingerprint: string;
                        /** @constant */
                        status: "READY";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listReleaseRuns: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                state?: "PREPARING" | "READY_FOR_APPROVAL" | "DECISION_RECORDING" | "DISPATCH_QUEUED" | "BLOCKED" | "SUPERSEDED" | "CANCELLED";
                taskId?: string;
                updatedSince?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            authorizationDecisionRecordId: string | null;
                            baseRef: string;
                            /** Format: date-time */
                            createdAt: string;
                            dispatches: {
                                /** Format: uuid */
                                id: string;
                                status: string;
                                /** Format: date-time */
                                updatedAt: string;
                            }[];
                            headSha: string;
                            /** Format: uuid */
                            id: string;
                            lastErrorCode: string | null;
                            /** @constant */
                            provider: "GITHUB";
                            pullRequestNumber: number;
                            /** Format: uri */
                            pullRequestUrl: string;
                            releasePolicyId: string;
                            repositoryName: string;
                            repositoryOwner: string;
                            sourceFingerprint: string;
                            /** @enum {string} */
                            state: "PREPARING" | "READY_FOR_APPROVAL" | "DECISION_RECORDING" | "DISPATCH_QUEUED" | "BLOCKED" | "SUPERSEDED" | "CANCELLED";
                            targetEnvironment: string;
                            taskIds: string[];
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listResearchStudies: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            appUrl: string | null;
                            artifactId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            goal: string;
                            guide: (string | {
                                id: string;
                                text: string;
                            })[];
                            /** Format: uuid */
                            id: string;
                            name: string;
                            sessionCount: number;
                            /** @enum {string} */
                            status: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                            /** @enum {string} */
                            studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST" | "EXTERNAL";
                            targetMinutes: number;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    appUrl?: string;
                    /** Format: uuid */
                    artifactId?: string;
                    goal: string;
                    guide: string[];
                    name: string;
                    /** @enum {string} */
                    studyType?: "CUSTOMER_INTERVIEW" | "USABILITY_TEST";
                    targetMinutes?: 10 | 15 | 20 | 30;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        appUrl: string | null;
                        artifactId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        goal: string;
                        guide: (string | {
                            id: string;
                            text: string;
                        })[];
                        /** Format: uuid */
                        id: string;
                        name: string;
                        sessionCount: number;
                        /** @enum {string} */
                        status: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                        /** @enum {string} */
                        studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST" | "EXTERNAL";
                        targetMinutes: number;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        appUrl: string | null;
                        artifactId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        goal: string;
                        guide: (string | {
                            id: string;
                            text: string;
                        })[];
                        /** Format: uuid */
                        id: string;
                        name: string;
                        sessionCount: number;
                        /** @enum {string} */
                        status: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                        /** @enum {string} */
                        studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST" | "EXTERNAL";
                        targetMinutes: number;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    appUrl?: string;
                    /** Format: uuid */
                    artifactId?: string;
                    goal?: string;
                    guide?: string[];
                    name: string;
                    /** @enum {string} */
                    studyType?: "CUSTOMER_INTERVIEW" | "USABILITY_TEST";
                    targetMinutes?: 10 | 15 | 20 | 30;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        appUrl: string | null;
                        artifactId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        goal: string;
                        guide: (string | {
                            id: string;
                            text: string;
                        })[];
                        /** Format: uuid */
                        id: string;
                        name: string;
                        sessionCount: number;
                        /** @enum {string} */
                        status: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                        /** @enum {string} */
                        studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST" | "EXTERNAL";
                        targetMinutes: number;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    activateResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uri */
                        participantUrl: string;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    archiveResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        participantUrl: null;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    closeResearchStudy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        participantUrl: null;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    revokeResearchParticipantLinks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        participantUrl: null;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    rotateResearchParticipantLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uri */
                        participantUrl: string;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    issueResearchParticipantLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uri */
                        participantUrl: string;
                        /** @enum {string} */
                        status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listResearchSessions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                status?: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "ABANDONED" | "EXPIRED";
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            endedReason: string | null;
                            hasSummary: boolean;
                            /** Format: uuid */
                            id: string;
                            lastActiveAt: string | null;
                            /** @enum {string} */
                            modality: "CHAT" | "VOICE";
                            startedAt: string | null;
                            status: string;
                            /** Format: uuid */
                            studyId: string;
                            turnCount: number;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getResearchSession: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        completedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        endedReason: string | null;
                        hasSummary: boolean;
                        /** Format: uuid */
                        id: string;
                        lastActiveAt: string | null;
                        /** @enum {string} */
                        modality: "CHAT" | "VOICE";
                        nextCursor: string | null;
                        startedAt: string | null;
                        status: string;
                        /** Format: uuid */
                        studyId: string;
                        turnCount: number;
                        turns: {
                            content: string;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            role: "PARTICIPANT" | "INTERVIEWER";
                            sequence: number;
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listResearchSyntheses: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            content: {
                                jobs: {
                                    context: string;
                                    evidenceTurnIds: string[];
                                    job: string;
                                }[];
                                patterns: {
                                    evidenceTurnIds: string[];
                                    text: string;
                                }[];
                                recommendations: {
                                    evidenceTurnIds: string[];
                                    text: string;
                                }[];
                                summary: string;
                                themes: {
                                    description: string;
                                    quotes: {
                                        sessionId: string;
                                        text: string;
                                        turnId: string;
                                    }[];
                                    surprising: boolean;
                                    title: string;
                                }[];
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            sessionCount: number;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createResearchSynthesis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    jobs: {
                        context: string;
                        evidenceTurnIds: string[];
                        job: string;
                    }[];
                    patterns: {
                        evidenceTurnIds: string[];
                        text: string;
                    }[];
                    recommendations: {
                        evidenceTurnIds: string[];
                        text: string;
                    }[];
                    summary: string;
                    themes: {
                        description: string;
                        quotes: {
                            sessionId: string;
                            text: string;
                            turnId: string;
                        }[];
                        surprising: boolean;
                        title: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        jobs: {
                            context: string;
                            evidenceTurnIds: string[];
                            job: string;
                        }[];
                        patterns: {
                            evidenceTurnIds: string[];
                            text: string;
                        }[];
                        recommendations: {
                            evidenceTurnIds: string[];
                            text: string;
                        }[];
                        summary: string;
                        themes: {
                            description: string;
                            quotes: {
                                sessionId: string;
                                text: string;
                                turnId: string;
                            }[];
                            surprising: boolean;
                            title: string;
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    promoteResearchEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    assumptionId?: string;
                    /** @enum {string} */
                    confidence?: "high" | "medium" | "low";
                    findingIndex: number;
                    /** Format: uuid */
                    opportunityId?: string;
                    /** Format: uuid */
                    solutionId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assumptionId: string | null;
                        findingKey: string;
                        /** Format: uuid */
                        id: string;
                        opportunityId: string | null;
                        replayed: boolean;
                        /** Format: uuid */
                        researchSynthesisId: string;
                        solutionId: string | null;
                        sourceTurnIds: string[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listReviewRequests: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                state?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            answers?: unknown[];
                            artifacts?: {
                                currentRevision: {
                                    revisionNumber: number;
                                } | null;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                                /** @enum {string} */
                                status: "ACTIVE" | "ARCHIVED";
                                title: string;
                            }[];
                            assignedToId: string | null;
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            currentRevision?: ({
                                answers?: unknown[];
                                chosenOption?: {
                                    actionKey?: string;
                                    description?: string | null;
                                    /** Format: uuid */
                                    id?: string;
                                    label: string;
                                    outcomeClass?: string;
                                } | null;
                                /** Format: date-time */
                                createdAt: string;
                                decisions?: {
                                    actorRole: string;
                                    /** Format: uuid */
                                    actorUserId: string;
                                    answersJson: string | null;
                                    /** Format: date-time */
                                    decidedAt: string;
                                    fingerprint: string;
                                    /** Format: uuid */
                                    id: string;
                                    idempotencyKey: string;
                                    option?: {
                                        actionKey: string;
                                        continuationKey: string;
                                        /** Format: date-time */
                                        createdAt: string;
                                        description: string | null;
                                        /** Format: uuid */
                                        id: string;
                                        label: string;
                                        outcomeClass: string;
                                        /** Format: uuid */
                                        revisionId: string;
                                        sortOrder: number;
                                    };
                                    /** Format: uuid */
                                    optionId: string;
                                    rationale: string | null;
                                    /** Format: uuid */
                                    requestId: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    /** Format: uuid */
                                    workspaceId: string;
                                }[];
                                expiresAt: string | null;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                options?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                }[];
                                packetJson: string;
                                questions?: unknown[];
                                /** Format: uuid */
                                requestId: string;
                                requiredRole: string;
                                reviewUrl?: string | null;
                                revisionNumber: number;
                                sourceFingerprint: string | null;
                                summary: string | null;
                                supersededAt: string | null;
                                title: string;
                            } | {
                                fingerprint: string;
                                title: string;
                            }) | null;
                            currentRevisionId: string | null;
                            decisionCycle: number;
                            dueAt: string | null;
                            expiresAt: string | null;
                            followUpTasks?: {
                                /** Format: uuid */
                                id: string;
                                status: string;
                                title: string;
                            }[];
                            gateType: string;
                            /** Format: uuid */
                            id: string;
                            noAction?: {
                                /** Format: date-time */
                                at: string;
                                reason: string | null;
                            } | null;
                            noActionAt: string | null;
                            noActionById: string | null;
                            noActionReason: string | null;
                            options?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            }[];
                            questions?: unknown[];
                            reconsidersDecisionId: string | null;
                            reopenedById: string | null;
                            reopenReason: string | null;
                            requestedBy?: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                                type: string;
                            } | null;
                            requestedByAgentId: string | null;
                            requestedById: string | null;
                            reviewUrl?: string | null;
                            revisionCount: number;
                            revisions?: {
                                answers?: unknown[];
                                chosenOption?: {
                                    actionKey?: string;
                                    description?: string | null;
                                    /** Format: uuid */
                                    id?: string;
                                    label: string;
                                    outcomeClass?: string;
                                } | null;
                                /** Format: date-time */
                                createdAt: string;
                                decisions?: {
                                    actorRole: string;
                                    /** Format: uuid */
                                    actorUserId: string;
                                    answersJson: string | null;
                                    /** Format: date-time */
                                    decidedAt: string;
                                    fingerprint: string;
                                    /** Format: uuid */
                                    id: string;
                                    idempotencyKey: string;
                                    option?: {
                                        actionKey: string;
                                        continuationKey: string;
                                        /** Format: date-time */
                                        createdAt: string;
                                        description: string | null;
                                        /** Format: uuid */
                                        id: string;
                                        label: string;
                                        outcomeClass: string;
                                        /** Format: uuid */
                                        revisionId: string;
                                        sortOrder: number;
                                    };
                                    /** Format: uuid */
                                    optionId: string;
                                    rationale: string | null;
                                    /** Format: uuid */
                                    requestId: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    /** Format: uuid */
                                    workspaceId: string;
                                }[];
                                expiresAt: string | null;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                options?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                }[];
                                packetJson: string;
                                questions?: unknown[];
                                /** Format: uuid */
                                requestId: string;
                                requiredRole: string;
                                reviewUrl?: string | null;
                                revisionNumber: number;
                                sourceFingerprint: string | null;
                                summary: string | null;
                                supersededAt: string | null;
                                title: string;
                            }[];
                            state: string;
                            /** Format: uuid */
                            subjectId: string;
                            subjectType: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getReviewRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        answers?: unknown[];
                        artifacts?: {
                            currentRevision: {
                                revisionNumber: number;
                            } | null;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            sourceType: "HTML_UPLOAD" | "EXTERNAL_LINK" | "V0_CHAT";
                            /** @enum {string} */
                            status: "ACTIVE" | "ARCHIVED";
                            title: string;
                        }[];
                        assignedToId: string | null;
                        chosenOption?: {
                            actionKey?: string;
                            description?: string | null;
                            /** Format: uuid */
                            id?: string;
                            label: string;
                            outcomeClass?: string;
                        } | null;
                        /** Format: date-time */
                        createdAt: string;
                        currentRevision?: ({
                            answers?: unknown[];
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            decisions?: {
                                actorRole: string;
                                /** Format: uuid */
                                actorUserId: string;
                                answersJson: string | null;
                                /** Format: date-time */
                                decidedAt: string;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                option?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                };
                                /** Format: uuid */
                                optionId: string;
                                rationale: string | null;
                                /** Format: uuid */
                                requestId: string;
                                /** Format: uuid */
                                revisionId: string;
                                /** Format: uuid */
                                workspaceId: string;
                            }[];
                            expiresAt: string | null;
                            fingerprint: string;
                            /** Format: uuid */
                            id: string;
                            options?: {
                                actionKey: string;
                                continuationKey: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                label: string;
                                outcomeClass: string;
                                /** Format: uuid */
                                revisionId: string;
                                sortOrder: number;
                            }[];
                            packetJson: string;
                            questions?: unknown[];
                            /** Format: uuid */
                            requestId: string;
                            requiredRole: string;
                            reviewUrl?: string | null;
                            revisionNumber: number;
                            sourceFingerprint: string | null;
                            summary: string | null;
                            supersededAt: string | null;
                            title: string;
                        } | {
                            fingerprint: string;
                            title: string;
                        }) | null;
                        currentRevisionId: string | null;
                        decisionCycle: number;
                        dueAt: string | null;
                        expiresAt: string | null;
                        followUpTasks?: {
                            /** Format: uuid */
                            id: string;
                            status: string;
                            title: string;
                        }[];
                        gateType: string;
                        /** Format: uuid */
                        id: string;
                        noAction?: {
                            /** Format: date-time */
                            at: string;
                            reason: string | null;
                        } | null;
                        noActionAt: string | null;
                        noActionById: string | null;
                        noActionReason: string | null;
                        options?: {
                            actionKey?: string;
                            description?: string | null;
                            /** Format: uuid */
                            id?: string;
                            label: string;
                            outcomeClass?: string;
                        }[];
                        questions?: unknown[];
                        reconsidersDecisionId: string | null;
                        reopenedById: string | null;
                        reopenReason: string | null;
                        requestedBy?: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            type: string;
                        } | null;
                        requestedByAgentId: string | null;
                        requestedById: string | null;
                        reviewUrl?: string | null;
                        revisionCount: number;
                        revisions?: {
                            answers?: unknown[];
                            chosenOption?: {
                                actionKey?: string;
                                description?: string | null;
                                /** Format: uuid */
                                id?: string;
                                label: string;
                                outcomeClass?: string;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                            decisions?: {
                                actorRole: string;
                                /** Format: uuid */
                                actorUserId: string;
                                answersJson: string | null;
                                /** Format: date-time */
                                decidedAt: string;
                                fingerprint: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                option?: {
                                    actionKey: string;
                                    continuationKey: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    description: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    label: string;
                                    outcomeClass: string;
                                    /** Format: uuid */
                                    revisionId: string;
                                    sortOrder: number;
                                };
                                /** Format: uuid */
                                optionId: string;
                                rationale: string | null;
                                /** Format: uuid */
                                requestId: string;
                                /** Format: uuid */
                                revisionId: string;
                                /** Format: uuid */
                                workspaceId: string;
                            }[];
                            expiresAt: string | null;
                            fingerprint: string;
                            /** Format: uuid */
                            id: string;
                            options?: {
                                actionKey: string;
                                continuationKey: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                label: string;
                                outcomeClass: string;
                                /** Format: uuid */
                                revisionId: string;
                                sortOrder: number;
                            }[];
                            packetJson: string;
                            questions?: unknown[];
                            /** Format: uuid */
                            requestId: string;
                            requiredRole: string;
                            reviewUrl?: string | null;
                            revisionNumber: number;
                            sourceFingerprint: string | null;
                            summary: string | null;
                            supersededAt: string | null;
                            title: string;
                        }[];
                        state: string;
                        /** Format: uuid */
                        subjectId: string;
                        subjectType: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listRoadmapItems: {
        parameters: {
            query: {
                cursor?: string;
                horizon?: string;
                limit: number;
                squadId?: string;
                status?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            endDate: string | null;
                            experimentId: string | null;
                            feedbackId: string | null;
                            horizon: string;
                            /** Format: uuid */
                            id: string;
                            isPrivate: boolean;
                            keyResultId: string | null;
                            opportunityId: string | null;
                            solutionId: string | null;
                            squadId: string | null;
                            startDate: string | null;
                            status: string;
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createRoadmapItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    endDate?: string | null;
                    feedbackId?: string | null;
                    /** @enum {string} */
                    horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED";
                    isPrivate?: boolean;
                    keyResultId?: string | null;
                    opportunityId?: string | null;
                    solutionId?: string | null;
                    squadId?: string | null;
                    startDate?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        experimentId: string | null;
                        feedbackId: string | null;
                        horizon: string;
                        /** Format: uuid */
                        id: string;
                        isPrivate: boolean;
                        keyResultId: string | null;
                        opportunityId: string | null;
                        solutionId: string | null;
                        squadId: string | null;
                        startDate: string | null;
                        status: string;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getRoadmapItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        experimentId: string | null;
                        feedbackId: string | null;
                        horizon: string;
                        /** Format: uuid */
                        id: string;
                        isPrivate: boolean;
                        keyResultId: string | null;
                        opportunityId: string | null;
                        solutionId: string | null;
                        squadId: string | null;
                        startDate: string | null;
                        status: string;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateRoadmapItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    endDate?: string | null;
                    /** @enum {string} */
                    horizon?: "LATER" | "NEXT" | "NOW" | "LAUNCHING" | "LAUNCHED" | "SHIPPED";
                    isPrivate?: boolean;
                    keyResultId?: string | null;
                    opportunityId?: string | null;
                    solutionId?: string | null;
                    squadId?: string | null;
                    startDate?: string | null;
                    /** @enum {string} */
                    status?: "ACTIVE" | "ARCHIVED";
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        experimentId: string | null;
                        feedbackId: string | null;
                        horizon: string;
                        /** Format: uuid */
                        id: string;
                        isPrivate: boolean;
                        keyResultId: string | null;
                        opportunityId: string | null;
                        solutionId: string | null;
                        squadId: string | null;
                        startDate: string | null;
                        status: string;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getLaunchChecklist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        count: number;
                        items: {
                            /** Format: uuid */
                            id: string;
                            label: string;
                            /** @enum {string} */
                            status: "PENDING" | "DONE" | "SKIPPED";
                        }[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    setLaunchTier: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    tier: "TIER_1" | "TIER_2" | "TIER_3";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        checklist: {
                            /** Format: uuid */
                            id: string;
                            itemCount: number;
                            name: string;
                            /** @enum {string} */
                            tier: "TIER_1" | "TIER_2" | "TIER_3";
                        };
                        item: {
                            /** @constant */
                            horizon: "LAUNCHING";
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            tier: "TIER_1" | "TIER_2" | "TIER_3";
                            title: string;
                        };
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getWorkspaceScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                entityType: "OPPORTUNITY" | "SOLUTION";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        entityType: "OPPORTUNITY" | "SOLUTION";
                        scoringModelId: string | null;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateWorkspaceScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                entityType: "OPPORTUNITY" | "SOLUTION";
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    scoringModelId: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        entityType: "OPPORTUNITY" | "SOLUTION";
                        scoringModelId: string | null;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listScoringModels: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** @enum {string} */
                            formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                            /** Format: uuid */
                            id: string;
                            metrics: {
                                description?: string | null;
                                /** @enum {string} */
                                direction: "POSITIVE" | "NEGATIVE";
                                key: string;
                                label: string;
                                maxValue: number;
                                minValue: number;
                                order?: number;
                                weight: number;
                            }[];
                            name: string;
                            /** Format: uuid */
                            organizationId: string;
                            /** @enum {string} */
                            status: "ACTIVE" | "ARCHIVED";
                            updatedAt: string;
                            version: number;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** @enum {string} */
                    formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                    metrics: {
                        description?: string | null;
                        /** @enum {string} */
                        direction: "POSITIVE" | "NEGATIVE";
                        key: string;
                        label: string;
                        maxValue: number;
                        minValue: number;
                        weight: number;
                    }[];
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @enum {string} */
                        formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                        /** Format: uuid */
                        id: string;
                        metrics: {
                            description?: string | null;
                            /** @enum {string} */
                            direction: "POSITIVE" | "NEGATIVE";
                            key: string;
                            label: string;
                            maxValue: number;
                            minValue: number;
                            order?: number;
                            weight: number;
                        }[];
                        name: string;
                        /** Format: uuid */
                        organizationId: string;
                        /** @enum {string} */
                        status: "ACTIVE" | "ARCHIVED";
                        updatedAt: string;
                        version: number;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @enum {string} */
                        formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                        /** Format: uuid */
                        id: string;
                        metrics: {
                            description?: string | null;
                            /** @enum {string} */
                            direction: "POSITIVE" | "NEGATIVE";
                            key: string;
                            label: string;
                            maxValue: number;
                            minValue: number;
                            order?: number;
                            weight: number;
                        }[];
                        name: string;
                        /** Format: uuid */
                        organizationId: string;
                        /** @enum {string} */
                        status: "ACTIVE" | "ARCHIVED";
                        updatedAt: string;
                        version: number;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    archiveScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateScoringModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    metrics?: {
                        description?: string | null;
                        /** @enum {string} */
                        direction: "POSITIVE" | "NEGATIVE";
                        key: string;
                        label: string;
                        maxValue: number;
                        minValue: number;
                        weight: number;
                    }[];
                    name?: string;
                } | {
                    description?: string | null;
                    /** @enum {string} */
                    formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                    metrics: {
                        description?: string | null;
                        /** @enum {string} */
                        direction: "POSITIVE" | "NEGATIVE";
                        key: string;
                        label: string;
                        maxValue: number;
                        minValue: number;
                        weight: number;
                    }[];
                    name?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @enum {string} */
                        formulaType: "WEIGHTED_SUM" | "MULTIPLICATIVE";
                        /** Format: uuid */
                        id: string;
                        metrics: {
                            description?: string | null;
                            /** @enum {string} */
                            direction: "POSITIVE" | "NEGATIVE";
                            key: string;
                            label: string;
                            maxValue: number;
                            minValue: number;
                            order?: number;
                            weight: number;
                        }[];
                        name: string;
                        /** Format: uuid */
                        organizationId: string;
                        /** @enum {string} */
                        status: "ACTIVE" | "ARCHIVED";
                        updatedAt: string;
                        version: number;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSolutionsBatch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    items: {
                        /** Format: uuid */
                        clientId?: string;
                        description?: string | null;
                        /** Format: uuid */
                        opportunityId: string;
                        title: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: ({
                            /** Format: uuid */
                            clientId: string;
                            /** @constant */
                            deduped?: true;
                            /** Format: uuid */
                            id: string;
                            /** @constant */
                            ok: true;
                        } | {
                            clientId: string;
                            /** @enum {string} */
                            code: "INVALID" | "PARENT_FAILED" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL";
                            error: string;
                            field?: string;
                            /** @constant */
                            ok: false;
                        })[];
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSolutionPlanEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorName: string;
                        authorType: string;
                        body: string;
                        commentType: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        parentId?: string | null;
                        planStatus?: string | null;
                        /** Format: uuid */
                        solutionId: string;
                        source: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteSolutionPlanEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateSolutionPlanEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorName: string;
                        authorType: string;
                        body: string;
                        commentType: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        parentId?: string | null;
                        planStatus?: string | null;
                        /** Format: uuid */
                        solutionId: string;
                        source: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listSolutions: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                opportunityId?: string;
                status?: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            createdAt: string;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            opportunityId: string;
                            /** @enum {string} */
                            status: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** Format: uuid */
                    opportunityId: string;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        opportunityId: string;
                        /** @enum {string} */
                        status: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        opportunityId: string;
                        /** @enum {string} */
                        status: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    title?: string;
                } | {
                    /** @enum {string} */
                    status: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        opportunityId: string;
                        /** @enum {string} */
                        status: "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED";
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkSolutionKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    keyResultId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        keyResultId: string;
                        /** Format: uuid */
                        solutionId: string;
                        source: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkSolutionKeyResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSolutionPlanComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorName: string;
                        authorType: string;
                        body: string;
                        commentType: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        parentId?: string | null;
                        planStatus?: string | null;
                        /** Format: uuid */
                        solutionId: string;
                        source: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listSolutionPlanEntries: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            authorName: string;
                            authorType: string;
                            body: string;
                            commentType: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            parentId?: string | null;
                            planStatus?: string | null;
                            /** Format: uuid */
                            solutionId: string;
                            source: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSolutionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorName: string;
                        authorType: string;
                        body: string;
                        commentType: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        parentId?: string | null;
                        planStatus?: string | null;
                        /** Format: uuid */
                        solutionId: string;
                        source: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    promoteSolutionToRoadmap: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED";
                    isPrivate?: boolean;
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        endDate: string | null;
                        experimentId: string | null;
                        feedbackId: string | null;
                        horizon: string;
                        /** Format: uuid */
                        id: string;
                        isPrivate: boolean;
                        keyResultId: string | null;
                        opportunityId: string | null;
                        solutionId: string | null;
                        squadId: string | null;
                        startDate: string | null;
                        status: string;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSolutionScore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        formulaSnapshot: unknown;
                        /** Format: uuid */
                        id: string;
                        modelVersion: number;
                        normalizedScore: number;
                        rawScore: number;
                        rawValues: {
                            [key: string]: number;
                        };
                        scoredAt: string;
                        /** Format: uuid */
                        scoringModelId: string;
                        updatedAt: string;
                    } & ({
                        /** Format: uuid */
                        opportunityId: string;
                    } | {
                        /** Format: uuid */
                        solutionId: string;
                    });
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    scoreSolution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    values: {
                        [key: string]: number;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        createdAt: string;
                        formulaSnapshot: unknown;
                        /** Format: uuid */
                        id: string;
                        modelVersion: number;
                        normalizedScore: number;
                        rawScore: number;
                        rawValues: {
                            [key: string]: number;
                        };
                        scoredAt: string;
                        /** Format: uuid */
                        scoringModelId: string;
                        updatedAt: string;
                    } & ({
                        /** Format: uuid */
                        opportunityId: string;
                    } | {
                        /** Format: uuid */
                        solutionId: string;
                    });
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listSquads: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            color: string;
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSquad: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    color?: string;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        color: string;
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSquad: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        color: string;
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateSquad: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    color?: string;
                    name?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        color: string;
                        createdAt: string;
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getWorkspaceSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        activeExperiments: number;
                        activeOkrCycle: {
                            /** Format: date-time */
                            endDate: string;
                            /** Format: uuid */
                            id: string;
                            /** Format: date-time */
                            startDate: string;
                            title: string;
                        } | null;
                        experimentCount: number;
                        name: string;
                        okrCycleCount: number;
                        opportunityCount: number;
                        roadmapItemCount: number;
                        squads: {
                            color: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                        }[];
                        thinkingModel: {
                            key: string;
                            labels: {
                                [key: string]: {
                                    plural: string;
                                    singular: string;
                                };
                            };
                            name: string;
                        };
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listTaskAssignees: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                search?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            displayName: string;
                            /** Format: uuid */
                            id: string;
                            ownerName?: string | null;
                            /** @enum {string} */
                            type: "USER" | "AGENT";
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listTasks: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
                parentTaskId?: string;
                priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
                squadId?: string;
                status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "BLOCKED" | "IN_REVIEW" | "DONE" | "CANCELLED";
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            assigneeAgentId: string | null;
                            assigneeUserId: string | null;
                            createdAt: string;
                            description: string | null;
                            /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                            displayId?: string | null;
                            dueDate: string | null;
                            /** Format: uuid */
                            id: string;
                            iteration: string | null;
                            ownerName: string | null;
                            parentTaskId: string | null;
                            priority: string;
                            squadId: string | null;
                            status: string;
                            storyPoints: number | null;
                            title: string;
                            updatedAt: string;
                            /** Format: uuid */
                            workspaceId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    assigneeUserId?: string | null;
                    description?: string | null;
                    dueDate?: string | null;
                    iteration?: string | null;
                    ownerName?: string | null;
                    parentTaskId?: string | null;
                    /** @enum {string} */
                    priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
                    squadId?: string | null;
                    /** @enum {string} */
                    status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "BLOCKED" | "IN_REVIEW" | "DONE" | "CANCELLED";
                    storyPoints?: number | null;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assigneeAgentId: string | null;
                        assigneeUserId: string | null;
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        dueDate: string | null;
                        /** Format: uuid */
                        id: string;
                        iteration: string | null;
                        ownerName: string | null;
                        parentTaskId: string | null;
                        priority: string;
                        squadId: string | null;
                        status: string;
                        storyPoints: number | null;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assigneeAgentId: string | null;
                        assigneeUserId: string | null;
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        dueDate: string | null;
                        /** Format: uuid */
                        id: string;
                        iteration: string | null;
                        ownerName: string | null;
                        parentTaskId: string | null;
                        priority: string;
                        squadId: string | null;
                        status: string;
                        storyPoints: number | null;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    assigneeUserId?: string | null;
                    description?: string | null;
                    dueDate?: string | null;
                    iteration?: string | null;
                    ownerName?: string | null;
                    /** @enum {string} */
                    priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
                    squadId?: string | null;
                    storyPoints?: number | null;
                    title?: string;
                } | {
                    /** @enum {string} */
                    status: "BACKLOG" | "TODO" | "IN_PROGRESS" | "BLOCKED" | "IN_REVIEW" | "DONE" | "CANCELLED";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assigneeAgentId: string | null;
                        assigneeUserId: string | null;
                        createdAt: string;
                        description: string | null;
                        /** @description Human-readable ID, unique within the workspace, e.g. TASK-12. Accepted wherever the UUID id is. */
                        displayId?: string | null;
                        dueDate: string | null;
                        /** Format: uuid */
                        id: string;
                        iteration: string | null;
                        ownerName: string | null;
                        parentTaskId: string | null;
                        priority: string;
                        squadId: string | null;
                        status: string;
                        storyPoints: number | null;
                        title: string;
                        updatedAt: string;
                        /** Format: uuid */
                        workspaceId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listTaskLinks: {
        parameters: {
            query: {
                cursor?: string;
                limit: number;
            };
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            linkedId: string;
                            linkedTitle: string;
                            /** @enum {string} */
                            linkedType: "OPPORTUNITY" | "SOLUTION" | "ROADMAP_ITEM" | "OBJECTIVE" | "KEY_RESULT" | "DOC" | "EXPERIMENT" | "FEEDBACK_ITEM" | "DECISION";
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    linkTaskResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    linkedId: string;
                    /** @enum {string} */
                    linkedType: "OPPORTUNITY" | "SOLUTION" | "ROADMAP_ITEM" | "OBJECTIVE" | "KEY_RESULT" | "DOC" | "EXPERIMENT" | "FEEDBACK_ITEM" | "DECISION";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        linkedId: string;
                        /** @enum {string} */
                        linkedType: "OPPORTUNITY" | "SOLUTION" | "ROADMAP_ITEM" | "OBJECTIVE" | "KEY_RESULT" | "DOC" | "EXPERIMENT" | "FEEDBACK_ITEM" | "DECISION";
                        /** Format: uuid */
                        taskId: string;
                    };
                };
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlinkTaskResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                linkedType: "OPPORTUNITY" | "SOLUTION" | "ROADMAP_ITEM" | "OBJECTIVE" | "KEY_RESULT" | "DOC" | "EXPERIMENT" | "FEEDBACK_ITEM" | "DECISION";
                relatedId: string;
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Problem Details */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Problem Details */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}

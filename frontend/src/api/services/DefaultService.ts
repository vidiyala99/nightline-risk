/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Body_upload_compliance_evidence_api_venues__venue_id__compliance__item_id__upload_post } from '../models/Body_upload_compliance_evidence_api_venues__venue_id__compliance__item_id__upload_post';
import type { IncidentCreate } from '../models/IncidentCreate';
import type { IncidentFlowResponse } from '../models/IncidentFlowResponse';
import type { LiveVenueState } from '../models/LiveVenueState';
import type { StreamEvent } from '../models/StreamEvent';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DefaultService {
    /**
     * Health
     * @returns string Successful Response
     * @throws ApiError
     */
    public static healthApiHealthGet(): CancelablePromise<Record<string, string>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/health',
        });
    }
    /**
     * List Venues
     * @returns any Successful Response
     * @throws ApiError
     */
    public static listVenuesApiVenuesGet(): CancelablePromise<Array<Record<string, any>>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/venues',
        });
    }
    /**
     * Create Incident
     * @param venueId
     * @param requestBody
     * @returns IncidentFlowResponse Successful Response
     * @throws ApiError
     */
    public static createIncidentApiVenuesVenueIdIncidentsPost(
        venueId: string,
        requestBody: IncidentCreate,
    ): CancelablePromise<IncidentFlowResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/venues/{venue_id}/incidents',
            path: {
                'venue_id': venueId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * List Incident Packets
     * @param incidentId
     * @returns any Successful Response
     * @throws ApiError
     */
    public static listIncidentPacketsApiIncidentsIncidentIdPacketsGet(
        incidentId: string,
    ): CancelablePromise<Array<Record<string, any>>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/incidents/{incident_id}/packets',
            path: {
                'incident_id': incidentId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Get Packet
     * @param packetId
     * @returns any Successful Response
     * @throws ApiError
     */
    public static getPacketApiPacketsPacketIdGet(
        packetId: string,
    ): CancelablePromise<Record<string, any>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/packets/{packet_id}',
            path: {
                'packet_id': packetId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Create Review Decision
     * @param packetId
     * @param requestBody
     * @returns any Successful Response
     * @throws ApiError
     */
    public static createReviewDecisionApiPacketsPacketIdReviewDecisionsPost(
        packetId: string,
        requestBody: Record<string, any>,
    ): CancelablePromise<Record<string, any>> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/packets/{packet_id}/review-decisions',
            path: {
                'packet_id': packetId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * List Packet Audit Events
     * @param packetId
     * @returns any Successful Response
     * @throws ApiError
     */
    public static listPacketAuditEventsApiPacketsPacketIdAuditEventsGet(
        packetId: string,
    ): CancelablePromise<Array<Record<string, any>>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/packets/{packet_id}/audit-events',
            path: {
                'packet_id': packetId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Get Live State
     * @param venueId
     * @returns LiveVenueState Successful Response
     * @throws ApiError
     */
    public static getLiveStateApiVenuesVenueIdLiveGet(
        venueId: string,
    ): CancelablePromise<LiveVenueState> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/venues/{venue_id}/live',
            path: {
                'venue_id': venueId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Upload Compliance Evidence
     * @param venueId
     * @param itemId
     * @param formData
     * @returns any Successful Response
     * @throws ApiError
     */
    public static uploadComplianceEvidenceApiVenuesVenueIdComplianceItemIdUploadPost(
        venueId: string,
        itemId: string,
        formData: Body_upload_compliance_evidence_api_venues__venue_id__compliance__item_id__upload_post,
    ): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/venues/{venue_id}/compliance/{item_id}/upload',
            path: {
                'venue_id': venueId,
                'item_id': itemId,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Ingest Event Stream
     * High-volume ingestion endpoint.
     * Accepts POS transactions, door scans, and camera metadata.
     * @param venueId
     * @param requestBody
     * @returns any Successful Response
     * @throws ApiError
     */
    public static ingestEventStreamApiVenuesVenueIdEventsStreamPost(
        venueId: string,
        requestBody: Array<StreamEvent>,
    ): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/venues/{venue_id}/events/stream',
            path: {
                'venue_id': venueId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * Login with email and password
     * @returns TokenResponse Successful Response
     * @throws ApiError
     */
    public static loginApiAuthLoginPost(
        email: string,
        password: string,
    ): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/auth/login',
            body: {
                email,
                password,
            },
        });
    }
    /**
     * Get current user info
     * @returns any Successful Response
     * @throws ApiError
     */
    public static getMeApiAuthMeGet(): CancelablePromise<Record<string, any>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/auth/me',
        });
    }
    /**
     * Register a new user
     * @returns TokenResponse Successful Response
     * @throws ApiError
     */
    public static registerApiAuthRegisterPost(
        email: string,
        password: string,
        name: string,
        role: string = "venue_operator",
    ): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/auth/register',
            body: {
                email,
                password,
                name,
                role,
            },
        });
    }
}

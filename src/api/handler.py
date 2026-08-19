# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Review API.

Routes:
  GET  /results  list analysis records, with presigned image and artefact URLs
  POST /analyze  start a pipeline execution for an image already in the bucket
  POST /upload   return a presigned PUT URL for a new image

Amazon API Gateway validates the caller's Amazon Cognito token before invoking
this function, so the handler does not repeat that check.
"""
import json
import os

import boto3

TABLE_NAME = os.environ["TABLE_NAME"]
IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]

_table = boto3.resource("dynamodb").Table(TABLE_NAME)
_s3 = boto3.client("s3")
_sfn = boto3.client("stepfunctions")

GET_URL_TTL = 3600
PUT_URL_TTL = 300
ALLOWED_SUFFIXES = (".jpg", ".jpeg", ".png")


def _presign_get(key):
    return _s3.generate_presigned_url(
        "get_object", Params={"Bucket": IMAGE_BUCKET, "Key": key}, ExpiresIn=GET_URL_TTL
    )


def lambda_handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")

    if method == "GET" and path.endswith("/results"):
        items = _table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq("image")
        ).get("Items", [])
        for item in items:
            item["imageUrl"] = _presign_get(item["sk"])
            for signal in item.get("signals", {}).values():
                if "artifactKey" in signal:
                    signal["artifactUrl"] = _presign_get(signal["artifactKey"])
        return _response(200, {"items": items})

    if method == "POST" and path.endswith("/analyze"):
        body = json.loads(event.get("body") or "{}")
        image_key = body.get("imageKey")
        if not image_key or not image_key.startswith("images/") or ".." in image_key:
            return _response(400, {"error": "imageKey is required and must sit under images/"})
        execution = _sfn.start_execution(
            stateMachineArn=STATE_MACHINE_ARN,
            input=json.dumps({"imageKey": image_key}),
        )
        return _response(202, {"executionArn": execution["executionArn"]})

    if method == "POST" and path.endswith("/upload"):
        body = json.loads(event.get("body") or "{}")
        filename = os.path.basename(body.get("filename", ""))
        if not filename or not filename.lower().endswith(ALLOWED_SUFFIXES):
            return _response(400, {"error": "filename must end in .jpg, .jpeg, or .png"})
        content_type = body.get("contentType", "image/jpeg")
        if content_type not in ("image/jpeg", "image/png"):
            return _response(400, {"error": "contentType must be image/jpeg or image/png"})
        key = f"images/uploads/{filename}"
        url = _s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": IMAGE_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=PUT_URL_TTL,
        )
        return _response(200, {"uploadUrl": url, "imageKey": key})

    return _response(404, {"error": f"no route for {method} {path}"})


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }

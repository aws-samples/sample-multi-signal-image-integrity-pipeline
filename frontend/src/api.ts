// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signIn, signOut, confirmSignIn, getCurrentUser } from 'aws-amplify/auth';

export interface SignalResult {
  verdict: 'pass' | 'flag';
  score: string;
  rationale: string;
  artifactKey?: string;
  artifactUrl?: string;
  failedCheck?: string;
}

export interface AnalysisRecord {
  pk: string;
  sk: string; // image key
  verdict: 'PASS' | 'FLAG';
  weightedScore: string;
  // Signals are scored in two groups, each judged against the threshold on its own: the
  // deterministic signals, and the model signals that read the submitted image and are
  // therefore reachable by text embedded in it. `corroboration` records which group drove
  // the verdict. Optional, because records written before this change do not carry them.
  deterministicScore?: string;
  llmScore?: string;
  corroboration?: 'deterministic' | 'llm_only' | 'none';
  signals: Record<string, SignalResult>;
  analyzedAt: string;
  imageUrl?: string;
}

let apiUrl = '';

export async function loadConfig(): Promise<void> {
  const res = await fetch('/config.json');
  const cfg = await res.json();
  apiUrl = (cfg.apiUrl as string).replace(/\/$/, '');
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.userPoolClientId,
      },
    },
  });
}

export async function currentUser(): Promise<string | null> {
  try {
    const user = await getCurrentUser();
    return user.username;
  } catch {
    return null;
  }
}

/** Returns 'signedIn', or 'newPasswordRequired' when the user must set a permanent password. */
export async function login(username: string, password: string): Promise<string> {
  const { nextStep } = await signIn({ username, password });
  if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
    return 'newPasswordRequired';
  }
  return 'signedIn';
}

export async function completeNewPassword(newPassword: string): Promise<void> {
  await confirmSignIn({ challengeResponse: newPassword });
}

export async function logout(): Promise<void> {
  await signOut();
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Not signed in');
  return { authorization: token };
}

async function getJson(path: string): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { headers: await authHeaders() });
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function fetchResults(): Promise<AnalysisRecord[]> {
  const res = await getJson('/results');
  const data = await res.json();
  return data.items ?? [];
}

export async function startAnalysis(imageKey: string): Promise<void> {
  await postJson('/analyze', { imageKey });
}

export async function uploadImage(file: File): Promise<string> {
  const res = await postJson('/upload', { filename: file.name, contentType: file.type });
  const { uploadUrl, imageKey } = await res.json();
  // The presigned PUT goes straight to Amazon S3 and carries its own signature,
  // so it must not include the Cognito authorization header.
  await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  return imageKey as string;
}

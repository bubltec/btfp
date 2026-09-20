import type {
  Breed,
  PendingContributionCard,
  PetType,
  QuizQuestion,
  Thing,
  ThingType,
  User,
} from '@btfp/shared-types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: undefined }));
    throw new Error(body.message ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type CurrentUser = User;

export const api = {
  listThings: (
    params: { q?: string; petType?: string; thingType?: string; breed?: string } = {},
  ) => {
    const entries = Object.entries(params).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    );
    const qs = new URLSearchParams(entries).toString();
    return request<Thing[]>(`/things${qs ? `?${qs}` : ''}`);
  },
  getThing: (id: string) => request<Thing>(`/things/${id}`),
  listPetTypes: () => request<PetType[]>('/pet-types'),
  listBreeds: (petType?: string) =>
    request<Breed[]>(`/breeds${petType ? `?petType=${petType}` : ''}`),
  listThingTypes: () => request<ThingType[]>('/thing-types'),
  me: () => request<CurrentUser>('/auth/me'),
  getQuiz: () => request<QuizQuestion[]>('/verification/quiz'),
  submitQuiz: (questions: QuizQuestion[], answers: number[]) =>
    request<{ verifiedContributor: boolean }>('/verification/quiz', {
      method: 'POST',
      body: JSON.stringify({ questions, answers }),
    }),
  submitContribution: (payload: Record<string, unknown>, thingId?: string) =>
    request('/contributions', { method: 'POST', body: JSON.stringify({ thingId, payload }) }),
  listPendingContributions: () => request<PendingContributionCard[]>('/contributions/pending'),
  rejectContribution: (thingId: string, sk: string, reason?: string) =>
    request<{ rejected: number }>(`/contributions/${thingId}/${encodeURIComponent(sk)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unlockDevContributor: () =>
    request<{ verifiedContributor: boolean }>('/auth/test/verify', { method: 'POST' }),
  requestProfessionalVerification: (email: string) =>
    request<{ orgClassification?: string }>('/verification/professional/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  confirmProfessionalVerification: (code: string) =>
    request<{ confirmed: boolean }>('/verification/professional/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  listPendingProfessionalVerifications: () => request<User[]>('/verification/professional/pending'),
  reviewProfessionalVerification: (userId: string, approve: boolean, reason?: string) =>
    request(`/verification/professional/${userId}/review`, {
      method: 'POST',
      body: JSON.stringify({ approve, reason }),
    }),
  requestEmailSignIn: (email: string) =>
    request<{ orgClassification?: string }>('/auth/email/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  confirmEmailSignIn: (email: string, code: string) =>
    request<{ confirmed: boolean }>('/auth/email/confirm', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
};

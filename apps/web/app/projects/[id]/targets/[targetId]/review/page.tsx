import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReviewResponse } from '@polycast/contracts';
import type { CommentsResponse } from '@/lib/contract-types';
import { apiGet } from '@/lib/api';
import { redirectIfUnauthenticated } from '@/lib/auth-redirect';
import { ApiError, describeError } from '@/lib/errors';
import { ReviewStudio } from './review-studio';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Review' };

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; targetId: string }>;
}) {
  const { id, targetId } = await params;
  let review: ReviewResponse;
  let comments: CommentsResponse = { comments: [] };
  try {
    review = await apiGet<ReviewResponse>(`/api/v1/target-jobs/${targetId}/review`);
    comments = await apiGet<CommentsResponse>(`/api/v1/target-jobs/${targetId}/comments`).catch(
      () => ({ comments: [] }),
    );
  } catch (e) {
    await redirectIfUnauthenticated(e);
    if (e instanceof ApiError && e.status === 404) notFound();
    return (
      <section aria-labelledby="review-error-heading">
        <h1 id="review-error-heading">Review</h1>
        <div className="card" role="alert">
          <strong>Could not load the review.</strong>
          <p className="muted">{describeError(e)}</p>
        </div>
      </section>
    );
  }
  return (
    <ReviewStudio
      projectId={id}
      targetId={targetId}
      initialReview={review}
      initialComments={comments.comments}
    />
  );
}

import { useParams } from 'react-router-dom';
import { FindingList } from '@/components/FindingList';

/** Thin route wrapper: all four finding categories share one list implementation. */
export function FindingsPage({
  endpoint,
  title,
  description,
  emptyMessage,
}: {
  endpoint: string;
  title: string;
  description: string;
  emptyMessage: string;
}) {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  if (!repositoryId) return null;

  return (
    <FindingList
      key={`${repositoryId}-${endpoint}`}
      repositoryId={repositoryId}
      endpoint={endpoint}
      title={title}
      description={description}
      emptyMessage={emptyMessage}
    />
  );
}

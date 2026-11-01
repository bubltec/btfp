import { Link } from 'react-router-dom';
import { slugify, type Thing } from '@btfp/shared-types';
import { SeverityBadge } from './SeverityBadge.js';

export function ThingCard({ thing }: { thing: Thing }) {
  return (
    <Link
      to={`/things/${thing.id}/${slugify(thing.name)}`}
      className="panel card block p-4 no-underline shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-neutral-800">{thing.name}</h3>
        <span className="shrink-0 rounded-full bg-paw-50 px-2 py-0.5 text-xs font-semibold text-paw-500 capitalize">
          {thing.thingTypeId}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {thing.petTypes.map((p) => (
          <span
            key={p.petTypeId}
            className="flex items-center gap-1 text-xs capitalize text-neutral-500"
          >
            {p.petTypeId}
            <SeverityBadge severity={p.severity} />
          </span>
        ))}
      </div>
    </Link>
  );
}

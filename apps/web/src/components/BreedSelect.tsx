import { Combobox } from '@base-ui/react/combobox';
import type { Breed } from '@btfp/shared-types';

export function BreedSelect({
  breeds,
  value,
  onChange,
}: {
  breeds: Breed[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = breeds.find((b) => b.id === value);

  return (
    <Combobox.Root<Breed>
      items={breeds}
      value={selected}
      onValueChange={(breed) => onChange(breed?.id ?? '')}
      itemToStringLabel={(breed) => breed.name}
    >
      <div className="relative flex-1">
        <Combobox.Input
          placeholder="Any breed (optional)"
          className="w-full rounded-full border border-paw-200 bg-white px-4 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-paw-400"
        />
        <Combobox.Clear
          aria-label="Clear breed"
          className="absolute top-1/2 right-3 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 data-[popup-open]:hidden"
        >
          ✕
        </Combobox.Clear>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="w-(--anchor-width)">
          <Combobox.Popup className="max-h-72 overflow-auto rounded-cozy border border-paw-200 bg-white p-1 shadow-lg">
            <Combobox.Empty className="px-3 py-1.5 text-sm text-neutral-400">
              No breed found.
            </Combobox.Empty>
            <Combobox.List>
              {(breed: Breed) => (
                <Combobox.Item
                  key={breed.id}
                  value={breed}
                  className="cursor-pointer rounded-lg px-3 py-1.5 text-sm data-[highlighted]:bg-paw-50"
                >
                  {breed.name}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

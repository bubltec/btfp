import { Select } from '@base-ui/react/select';
import type { PetType } from '@btfp/shared-types';

export function PetTypeSelect({
  petTypes,
  value,
  onChange,
}: {
  petTypes: PetType[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(String(v))}>
      <Select.Trigger className="flex items-center gap-2 rounded-full border border-paw-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700">
        <Select.Value className="capitalize">
          {(value: string) => (value ? value : 'All pets')}
        </Select.Value>
        <Select.Icon aria-hidden>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6}>
          <Select.Popup className="rounded-cozy border border-paw-200 bg-white p-1 shadow-lg">
            <Select.Item
              value=""
              className="cursor-pointer rounded-lg px-3 py-1.5 text-sm data-[highlighted]:bg-paw-50"
            >
              <Select.ItemText>All pets</Select.ItemText>
            </Select.Item>
            {petTypes.map((petType) => (
              <Select.Item
                key={petType.id}
                value={petType.id}
                className="cursor-pointer rounded-lg px-3 py-1.5 text-sm capitalize data-[highlighted]:bg-paw-50"
              >
                <Select.ItemText>{petType.name}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

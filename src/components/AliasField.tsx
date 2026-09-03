/**
 * Name for a wallet. Every wallet in the file shares one password, so the alias is the only thing
 * distinguishing "my mining payouts" from "cold storage" in the switcher — an address prefix is
 * not something anyone recognises at a glance.
 */
export function AliasField({
  value,
  onChange,
  placeholder = "e.g. Mining payouts",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mt-3">
      <label className="label">Wallet name (optional)</label>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={40}
      />
    </div>
  );
}

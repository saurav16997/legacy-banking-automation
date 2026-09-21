/** Synthetic fixture placeholders; real customer data is prohibited. */
export const fixturesPlaceholder = true;
export interface Account {
  id: string;
  type: "checking" | "savings";
  product: string;
  nickname: string;
  balanceCents: number;
  lastFour: string;
}

export interface Member {
  id: string;
  name: string;
  status: "Active";
  accounts: Account[];
}

const initialMembers: Member[] = [
  {
    id: "M-10042",
    name: "Morgan Redwood",
    status: "Active",
    accounts: [
      {
        id: "CHK-1842",
        type: "checking",
        product: "Everyday Checking",
        nickname: "Primary Checking",
        balanceCents: 425_075,
        lastFour: "1842",
      },
    ],
  },
  {
    id: "M-20017",
    name: "Casey Juniper",
    status: "Active",
    accounts: [
      {
        id: "CHK-9021",
        type: "checking",
        product: "Essential Checking",
        nickname: "Household Checking",
        balanceCents: 318_940,
        lastFour: "9021",
      },
    ],
  },
];

function cloneInitialMembers(): Member[] {
  return structuredClone(initialMembers);
}

export class FixtureStore {
  private members = cloneInitialMembers();
  private nextSavingsSequence = 1;

  reset(): void {
    this.members = cloneInitialMembers();
    this.nextSavingsSequence = 1;
  }

  findMember(memberId: string): Member | undefined {
    return this.members.find((member) => member.id === memberId);
  }

  listMembers(): Member[] {
    return this.members;
  }

  createSavingsAccount(
    memberId: string,
    details: { product: string; nickname: string; initialDepositCents: number },
  ): Account | undefined {
    const member = this.findMember(memberId);
    if (!member) return undefined;

    const sequence = this.nextSavingsSequence;
    this.nextSavingsSequence += 1;
    const account: Account = {
      id: `SAV-${String(sequence).padStart(4, "0")}`,
      type: "savings",
      product: details.product,
      nickname: details.nickname,
      balanceCents: details.initialDepositCents,
      lastFour: String(7000 + sequence),
    };
    member.accounts.push(account);
    return account;
  }
}

export const demoCredentials = {
  username: "demo.operator",
  password: "creditunion-demo",
} as const;

export const syntheticVerificationCode = "739241";

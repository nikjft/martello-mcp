import { McGawSemantics } from './dist/semantics.js';

const mockClient = {};
const semantics = new McGawSemantics(mockClient);

const testCases = [
  { name: "EPIC: Project X", expected: true },
  { name: "SUB-EPIC: Feature Y", expected: true },
  { name: "Task: Fix bug", expected: false },
  { name: "Just a card", expected: false },
  { name: "Client Name: EPIC: Project Z", expected: true },
  { name: "(3) EPIC: Groomed Epic", expected: true },
];

console.log("Testing isEpicOrSubEpic...");
testCases.forEach(tc => {
  const result = semantics.isEpicOrSubEpic(tc.name);
  console.log(`Title: "${tc.name}" | Expected: ${tc.expected} | Result: ${result} | ${result === tc.expected ? "PASS" : "FAIL"}`);
});

// Testing the logic from update_card_details in index.ts
async function testUpdateEnforcement(title, startDate) {
    if (startDate) {
        if (!semantics.isEpicOrSubEpic(title)) {
            return "ERROR: Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date.";
        }
    }
    return "SUCCESS";
}

console.log("\nTesting Enforcement Logic...");
const enforcementCases = [
    { title: "EPIC: Project A", startDate: "2024-01-01", expected: "SUCCESS" },
    { title: "Task B", startDate: "2024-01-01", expected: "ERROR: Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date." },
    { title: "Task C", startDate: undefined, expected: "SUCCESS" },
];

(async () => {
    for (const ec of enforcementCases) {
        const res = await testUpdateEnforcement(ec.title, ec.startDate);
        console.log(`Title: "${ec.title}" | StartDate: ${ec.startDate} | Result: ${res === ec.expected ? "PASS" : "FAIL"} (${res})`);
    }
})();

import{expect,test}from"bun:test";import{findPrivacy}from"../scripts/privacy-scan";
test("privacy patterns identify examples without returning personal values",()=>{
 const hits=findPrivacy("person@example.invalid +12025550123 http://127.0.0.1:9");
 expect(hits.some(h=>h.rule==="email"&&h.example)).toBe(true);expect(hits.some(h=>h.rule==="phone"&&h.example)).toBe(true);expect(hits.some(h=>h.rule==="ipv4"&&h.example)).toBe(true);expect(hits.every(h=>!Object.hasOwn(h,"value"))).toBe(true);
});
test("private-looking home paths remain findings",()=>{const value="/"+["home","synthetic-user","notes"].join("/");expect(findPrivacy(value)).toEqual([{rule:"personal-home-path",line:1,example:false}]);});

test("public automation noreply is an example, not a waiver for arbitrary addresses",()=>{expect(findPrivacy("noreply@github.com")[0]!.example).toBe(true);expect(findPrivacy("person"+"@"+"unapproved"+".tld")[0]!.example).toBe(false);});

import { exec, home } from "herdr";
export async function request(data) {
  const result = await exec("python3", [home() + "/.local/share/herdr-automations/cli.py", JSON.stringify(data)]);
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new Error(result.stderr || "자동화 서비스를 설치하세요. docs/automations.md 참고"); }
  if (result.code || !response.ok) throw new Error(response.error || "자동화 요청 실패");
  return response.result;
}
export const requestId = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;

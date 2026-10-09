/** 检测私钥及常见凭据赋值，阻止敏感正文进入知识持久化或索引。 */
export function containsKnowledgeSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b|(?:api[_-]?key|access[_-]?token|password|密码|密钥)\s*[=:：]\s*["']?[^\s"']{8,}/i.test(text)
}

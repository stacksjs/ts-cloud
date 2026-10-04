/**
 * Readers for the shapes AWSClient.parseXmlResponse produces.
 *
 * The parser strips a response's single root element, so a query-API body
 * `<CreateTopicResponse><CreateTopicResult>..</CreateTopicResult>..` arrives
 * as `{ CreateTopicResult: .., ResponseMetadata: .. }`. Reading through
 * `result.CreateTopicResponse` finds nothing, and so does reading the result's
 * fields straight off `result`. It also turns a lone list element into a bare
 * object and `true`/`123` text into a boolean or number.
 */

/**
 * The `<{Action}Result>` of a query-API (SNS, SQS, SES v1, CloudFormation,
 * ...) response. The wrapped form is accepted too, in case the parser ever
 * stops unwrapping.
 */
export function queryResult(result: any, action: string): any {
  return (result?.[`${action}Response`] ?? result)?.[`${action}Result`]
}

/** A repeated XML element as an array: the parser yields one as a bare value and none as `''` or undefined. */
export function asList<T = any>(value: unknown): T[] {
  if (value === undefined || value === null || value === '')
    return []
  return (Array.isArray(value) ? value : [value]) as T[]
}

/** An XML boolean, whether the parser kept it as text or converted it. */
export function isTrue(value: unknown): boolean {
  return value === true || value === 'true'
}

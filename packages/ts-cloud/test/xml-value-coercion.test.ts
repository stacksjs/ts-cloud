/**
 * AWSClient converts parsed XML text to numbers only when nothing is lost.
 *
 * The parser's own conversion turned any numeric-looking text into a number,
 * so `+18082188241` lost its plus sign, an ElastiCache engine version `7.0`
 * read as 7, and a 20-digit identifier came back rounded.
 */

import { describe, expect, it } from 'bun:test'
import { AWSClient, coerceXmlValues } from '../src/aws/client'
import { SNSClient } from '../src/aws/sns'

describe('coerceXmlValues', () => {
  it('makes a number only of text that reads back identically', () => {
    expect(coerceXmlValues(['16', '0', '-3', '3.14', '923076644019'])).toEqual([16, 0, -3, 3.14, 923076644019])
  })

  it('keeps lossy numeric-looking text as a string', () => {
    const lossy = ['+18082188241', '7.0', '1.50', '0001', '00', '-0', '1e3', '0x1F', '.5', '5.', '12345678901234567890', 'Infinity', 'NaN']
    expect(coerceXmlValues(lossy)).toEqual(lossy)
  })

  it('still converts true and false, and leaves other text and empty values alone', () => {
    expect(coerceXmlValues({ a: 'true', b: 'false', c: 'True', d: '', e: 'v1' })).toEqual({ a: true, b: false, c: 'True', d: '', e: 'v1' })
  })

  it('applies to attributes and mixed text nodes', () => {
    expect(coerceXmlValues({ item: [{ '@_count': '2', '#text': '7.0' }] })).toEqual({ item: [{ '@_count': 2, '#text': '7.0' }] })
  })
})

describe('AWSClient.parseXmlResponse keeps lossy values as text', () => {
  it('returns a phone number with its plus sign and a version as written', () => {
    const aws: any = new AWSClient()
    expect(aws.parseXmlResponse('<R><Phone>+15555550100</Phone><Version>7.0</Version><Port>6379</Port><On>true</On></R>'))
      .toEqual({ Phone: '+15555550100', Version: '7.0', Port: 6379, On: true })
  })

  it('reaches SNS: a sandbox phone number keeps its plus sign (it came back as a number)', async () => {
    const sns = new SNSClient('us-east-1')
    const aws: any = (sns as any).client
    aws.request = async () => aws.parseXmlResponse('<?xml version="1.0"?>\n<ListSMSSandboxPhoneNumbersResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><ListSMSSandboxPhoneNumbersResult><PhoneNumbers><member><PhoneNumber>+15555550100</PhoneNumber><Status>Pending</Status></member></PhoneNumbers></ListSMSSandboxPhoneNumbersResult></ListSMSSandboxPhoneNumbersResponse>')
    expect(await sns.listSMSSandboxPhoneNumbers()).toEqual({ PhoneNumbers: [{ PhoneNumber: '+15555550100', Status: 'Pending' }], NextToken: undefined })
  })
})

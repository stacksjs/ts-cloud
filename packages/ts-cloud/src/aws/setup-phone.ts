import { ConnectClient } from './connect'

const connect = new ConnectClient('us-east-1')
const instanceId = '7deb6488-8555-4304-b893-d6c461449eda'

async function main() {
  // First, check which phone number we have
  console.log('Checking claimed phone numbers...')
  const phones = await connect.listPhoneNumbers({ InstanceId: instanceId })
  console.log('Claimed phone numbers:')
  for (const p of phones.ListPhoneNumbersSummaryList || []) {
    console.log('  ', p.PhoneNumber, '(ID:', p.PhoneNumberId + ')')
  }

  // Use the first phone number
  const phoneNumber = phones.ListPhoneNumbersSummaryList?.[0]
  if (!phoneNumber) {
    console.log('No phone numbers found!')
    process.exit(1)
  }

  // Create a contact flow with the correct format for call forwarding
  console.log('\nCreating contact flow with call forwarding...')

  // Use the correct format for TransferToPhoneNumber
  // According to AWS documentation, the action type is "TransferToPhoneNumber"
  const forwardingFlow = {
    Version: '2019-10-30',
    StartAction: 'transfer-to-phone',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'transfer-to-phone': { position: { x: 190, y: 40 } },
        'end-call': { position: { x: 440, y: 40 } },
      },
    },
    Actions: [
      {
        Identifier: 'transfer-to-phone',
        Type: 'TransferToPhoneNumber',
        Parameters: {
          PhoneNumber: '+18088218241',
          ContactFlowId: '', // Will use instance default
        },
        Transitions: {
          NextAction: 'end-call',
          Errors: [
            { ErrorType: 'NoMatchingError', NextAction: 'end-call' },
            { ErrorType: 'CallFailed', NextAction: 'end-call' },
            { ErrorType: 'ConnectionTimeLimitExceeded', NextAction: 'end-call' },
          ],
        },
      },
      {
        Identifier: 'end-call',
        Type: 'DisconnectParticipant',
        Parameters: {},
        Transitions: {},
      },
    ],
  }

  try {
    const flowResult = await connect.createContactFlow({
      InstanceId: instanceId,
      Name: 'Stacks Call Forwarding',
      Type: 'CONTACT_FLOW',
      Content: JSON.stringify(forwardingFlow),
      Description: 'Forwards all calls to +18088218241',
    })
    console.log('Contact flow created!')
    console.log('Flow ID:', flowResult.ContactFlowId)
    console.log('Flow ARN:', flowResult.ContactFlowArn)

    // Associate the phone number with the contact flow
    console.log('\nAssociating phone number with contact flow...')
    await connect.associatePhoneNumberContactFlow({
      PhoneNumberId: phoneNumber.PhoneNumberId!,
      InstanceId: instanceId,
      ContactFlowId: flowResult.ContactFlowId!,
    })
    console.log('Phone number associated with contact flow!')

    // Format the phone number
    const num = phoneNumber.PhoneNumber!
    const formatted = `+1 (${num.slice(2, 5)}) ${num.slice(5, 8)}-${num.slice(8)}`

    console.log('\n========================================')
    console.log('  STACKS PHONE NUMBER IS READY!')
    console.log('========================================')
    console.log('')
    console.log('  Call: ' + formatted)
    console.log('  Raw:  ' + num)
    console.log('  Forwards to: +1 (808) 821-8241')
    console.log('  Hours: 11:30 AM - 8:00 PM PST')
    console.log('')
    console.log('========================================')
  }
  catch (e: any) {
    console.log('Error:', e.message)
  }
}

main()

/**
 * IVR Builder (Visual Contact Flow Editor)
 *
 * Provides a programmatic way to build Amazon Connect contact flows
 */

export interface IVRFlow {
  id: string
  name: string
  description?: string
  nodes: IVRNode[]
  connections: IVRConnection[]
  startNodeId: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface IVRNode {
  id: string
  type: IVRNodeType
  position: { x: number; y: number }
  config: Record<string, any>
  label?: string
}

export type IVRNodeType =
  | 'start'
  | 'play-prompt'
  | 'get-input'
  | 'menu'
  | 'transfer-queue'
  | 'transfer-agent'
  | 'transfer-phone'
  | 'invoke-lambda'
  | 'set-attribute'
  | 'check-attribute'
  | 'check-hours'
  | 'check-queue'
  | 'record-voicemail'
  | 'disconnect'
  | 'loop'
  | 'wait'

export interface IVRConnection {
  id: string
  sourceNodeId: string
  targetNodeId: string
  sourcePort: string
  label?: string
}

/**
 * IVR Builder Module
 */
export class IVRBuilder {
  private nodes: IVRNode[] = []
  private connections: IVRConnection[] = []
  private startNodeId: string = ''

  /**
   * Create a new IVR flow
   */
  static create(name: string): IVRBuilder {
    const builder = new IVRBuilder()
    return builder
  }

  /**
   * Add a start node
   */
  start(): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'start',
      position: { x: 0, y: 0 },
      config: {},
    }
    this.nodes.push(node)
    this.startNodeId = node.id
    return this
  }

  /**
   * Add a play prompt node
   */
  playPrompt(text: string, options?: { ssml?: boolean; voice?: string }): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'play-prompt',
      position: { x: 0, y: 0 },
      config: {
        text,
        textType: options?.ssml ? 'ssml' : 'text',
        voice: options?.voice || 'Joanna',
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a get input node (DTMF)
   */
  getInput(prompt: string, options?: {
    maxDigits?: number
    timeout?: number
    errorPrompt?: string
  }): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'get-input',
      position: { x: 0, y: 0 },
      config: {
        prompt,
        maxDigits: options?.maxDigits || 1,
        timeout: options?.timeout || 5,
        errorPrompt: options?.errorPrompt || 'Sorry, I didn\'t get that.',
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a menu node
   */
  menu(prompt: string, options: Record<string, string>): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'menu',
      position: { x: 0, y: 0 },
      config: {
        prompt,
        options,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a transfer to queue node
   */
  transferToQueue(queueArn: string, options?: { priority?: number }): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'transfer-queue',
      position: { x: 0, y: 0 },
      config: {
        queueArn,
        priority: options?.priority || 5,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a transfer to phone number node
   */
  transferToPhone(phoneNumber: string): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'transfer-phone',
      position: { x: 0, y: 0 },
      config: {
        phoneNumber,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a Lambda invocation node
   */
  invokeLambda(functionArn: string, options?: { timeout?: number }): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'invoke-lambda',
      position: { x: 0, y: 0 },
      config: {
        functionArn,
        timeout: options?.timeout || 8,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a set attribute node
   */
  setAttribute(key: string, value: string): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'set-attribute',
      position: { x: 0, y: 0 },
      config: {
        key,
        value,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a check hours node
   */
  checkHours(hoursOfOperationArn: string): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'check-hours',
      position: { x: 0, y: 0 },
      config: {
        hoursOfOperationArn,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a record voicemail node
   */
  recordVoicemail(options?: {
    maxDuration?: number
    greeting?: string
    beep?: boolean
  }): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'record-voicemail',
      position: { x: 0, y: 0 },
      config: {
        maxDuration: options?.maxDuration || 120,
        greeting: options?.greeting || 'Please leave a message after the beep.',
        beep: options?.beep !== false,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a wait node
   */
  wait(seconds: number): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'wait',
      position: { x: 0, y: 0 },
      config: {
        seconds,
      },
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Add a disconnect node
   */
  disconnect(): this {
    const node: IVRNode = {
      id: this.generateId(),
      type: 'disconnect',
      position: { x: 0, y: 0 },
      config: {},
    }
    this.nodes.push(node)
    this.connectToLast(node.id)
    return this
  }

  /**
   * Build the IVR flow
   */
  build(): IVRFlow {
    return {
      id: this.generateId(),
      name: 'IVR Flow',
      nodes: this.nodes,
      connections: this.connections,
      startNodeId: this.startNodeId,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Convert to Amazon Connect contact flow format
   */
  toContactFlow(): string {
    const actions: any[] = []
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]))

    for (const node of this.nodes) {
      const action = this.nodeToAction(node, nodeMap)
      if (action) actions.push(action)
    }

    const flow = {
      Version: '2019-10-30',
      StartAction: this.startNodeId,
      Actions: actions,
    }

    return JSON.stringify(flow, null, 2)
  }

  private nodeToAction(node: IVRNode, nodeMap: Map<string, IVRNode>): any {
    const nextNodeId = this.getNextNodeId(node.id)
    const transitions = {
      NextAction: nextNodeId || 'disconnect',
      Errors: [{ NextAction: 'disconnect' }],
    }

    switch (node.type) {
      case 'start':
        return null // Start is implicit

      case 'play-prompt':
        return {
          Identifier: node.id,
          Type: 'MessageParticipant',
          Parameters: {
            Text: node.config.text,
            TextType: node.config.textType,
          },
          Transitions: transitions,
        }

      case 'get-input':
        return {
          Identifier: node.id,
          Type: 'GetParticipantInput',
          Parameters: {
            Text: node.config.prompt,
            InputTimeLimitSeconds: node.config.timeout,
            MaxDigits: node.config.maxDigits,
          },
          Transitions: {
            ...transitions,
            Conditions: [],
          },
        }

      case 'transfer-queue':
        return {
          Identifier: node.id,
          Type: 'TransferToQueue',
          Parameters: {
            QueueId: node.config.queueArn,
          },
          Transitions: transitions,
        }

      case 'transfer-phone':
        return {
          Identifier: node.id,
          Type: 'TransferToPhoneNumber',
          Parameters: {
            PhoneNumber: node.config.phoneNumber,
          },
          Transitions: transitions,
        }

      case 'invoke-lambda':
        return {
          Identifier: node.id,
          Type: 'InvokeLambdaFunction',
          Parameters: {
            LambdaFunctionARN: node.config.functionArn,
            InvocationTimeLimitSeconds: node.config.timeout,
          },
          Transitions: transitions,
        }

      case 'set-attribute':
        return {
          Identifier: node.id,
          Type: 'UpdateContactAttributes',
          Parameters: {
            Attributes: {
              [node.config.key]: node.config.value,
            },
          },
          Transitions: transitions,
        }

      case 'check-hours':
        return {
          Identifier: node.id,
          Type: 'CheckHoursOfOperation',
          Parameters: {
            HoursOfOperationId: node.config.hoursOfOperationArn,
          },
          Transitions: {
            NextAction: nextNodeId,
            Conditions: [
              { NextAction: nextNodeId, Condition: { Operator: 'Equals', Operands: ['True'] } },
            ],
            Errors: [{ NextAction: 'disconnect' }],
          },
        }

      case 'wait':
        return {
          Identifier: node.id,
          Type: 'Wait',
          Parameters: {
            Seconds: node.config.seconds,
          },
          Transitions: transitions,
        }

      case 'disconnect':
        return {
          Identifier: node.id,
          Type: 'DisconnectParticipant',
          Parameters: {},
          Transitions: {},
        }

      default:
        return null
    }
  }

  private connectToLast(targetId: string): void {
    if (this.nodes.length > 1) {
      const sourceNode = this.nodes[this.nodes.length - 2]
      this.connections.push({
        id: this.generateId(),
        sourceNodeId: sourceNode.id,
        targetNodeId: targetId,
        sourcePort: 'default',
      })
    }
  }

  private getNextNodeId(nodeId: string): string | null {
    const connection = this.connections.find(c => c.sourceNodeId === nodeId)
    return connection?.targetNodeId || null
  }

  private generateId(): string {
    return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Pre-built IVR templates
   */
  static readonly Templates = {
    basicSupport: (): IVRBuilder => {
      return IVRBuilder.create('Basic Support')
        .start()
        .playPrompt('Welcome to customer support.')
        .menu('Press 1 for sales, 2 for support, or 3 to leave a message.', {
          '1': 'sales',
          '2': 'support',
          '3': 'voicemail',
        })
    },

    afterHours: (greeting: string): IVRBuilder => {
      return IVRBuilder.create('After Hours')
        .start()
        .playPrompt(greeting)
        .recordVoicemail({
          greeting: 'Please leave your name, number, and a brief message.',
          maxDuration: 120,
        })
        .playPrompt('Thank you for your message. Goodbye.')
        .disconnect()
    },

    callbackRequest: (lambdaArn: string): IVRBuilder => {
      return IVRBuilder.create('Callback Request')
        .start()
        .playPrompt('All agents are currently busy.')
        .getInput('Press 1 to request a callback, or 2 to wait.', { maxDigits: 1 })
        .invokeLambda(lambdaArn)
        .playPrompt('We will call you back shortly. Goodbye.')
        .disconnect()
    },
  }
}

export default IVRBuilder

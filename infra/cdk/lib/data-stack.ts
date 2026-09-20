import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { EnvConfig } from './config.js';

export interface DataStackProps extends cdk.StackProps {
  envConfig: EnvConfig;
}

/**
 * Single-table design for content (things / thing-types / pet-types /
 * pending contributions), plus a separate users table. On-demand billing
 * throughout to stay cheap at low/unknown traffic.
 */
export class DataStack extends cdk.Stack {
  readonly contentTable: dynamodb.Table;
  readonly usersTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.envConfig.envName === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.contentTable = new dynamodb.Table(this, 'ContentTable', {
      tableName: `btfp-${props.envConfig.envName}-content`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
      removalPolicy,
    });

    // Browse by thing type, e.g. GSI1PK=THINGTYPE#plant / GSI1SK=THING#<name>
    this.contentTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // Moderation queue, e.g. GSI2PK=STATUS#pending / GSI2SK=CONTRIB#<createdAt>
    this.contentTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `btfp-${props.envConfig.envName}-users`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    // Users are keyed by provider+providerAccountId (PK), but reviewing a
    // professional-verification request needs a lookup by internal id.
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
    });
  }
}
